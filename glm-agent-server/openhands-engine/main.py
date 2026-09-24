"""Sidecar OpenHands — second moteur d'agent du glm-agent-server.

Rôle : faire tourner la boucle agentique OpenHands (MIT) avec GLM-5.3-Flash via RCP,
qui a remplacé le harness Claude Code (propriétaire) comme moteur par défaut. Le serveur Node reste
le point d'entrée unique : il possède les tools (TypeScript), les gardes
d'auth et le contrat SSE des frontends.

Ce sidecar ne connaît AUCUN secret utilisateur : les tools sont des proxys —
chaque exécution est un POST vers le serveur Node (/internal/tool-exec) qui
détient le contexte de la requête (tokens Graph/Entra, registre de refs…).

    Node /chat (engine=openhands)
      → POST ici /run {run_id, system_prompt, message, tools[], callback_url}
      ← NDJSON stream {text_delta | tool_use | tool_result | usage | result | error}
      (pendant le run : POST callback_url pour chaque tool → résultat)

Démarrage : .venv\\Scripts\\python.exe -m uvicorn main:app --port 8792
"""
import json
import os
import queue
import threading
import uuid
from typing import Any

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

import httpx
import litellm
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, SecretStr

from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.sdk.llm.message import ImageContent, Message, TextContent
from openhands.sdk.event import ActionEvent, MessageEvent, ObservationEvent
from openhands.sdk.tool import ToolExecutor, register_tool
from openhands.sdk.tool.client_tool import ClientTool, ClientToolObservation

RCP_KEY = os.environ.get("RCP_API_KEY", "")
RCP_BASE_URL = os.environ.get("RCP_BASE_URL", "https://inference.rcp.epfl.ch/v1")
MODEL = os.environ.get("AGENT_MODEL", "zai-org/GLM-5.3-Flash")
PORT = int(os.environ.get("OPENHANDS_PORT", "8792"))

# LiteLLM ne connaît pas les modèles RCP. Sans cette fiche, OpenHands croit le
# modèle aveugle et REFUSE les images (« the currently selected model does not
# support image understanding »), et chaque appel logue un échec de calcul de
# coût. GLM-5.3-Flash lit les images — vérifié sur RCP le 24.09.2026. Coût nul :
# RCP est interne, la consommation se suit ailleurs. Enregistré sous toutes les
# formes du nom que le SDK consulte.
_MODEL_CARD = {
    "litellm_provider": "openai",
    "mode": "chat",
    "supports_vision": True,
    "supports_function_calling": True,
    "max_input_tokens": 1_048_576,
    "input_cost_per_token": 0.0,
    "output_cost_per_token": 0.0,
}
litellm.register_model({
    name: _MODEL_CARD for name in (f"openai/{MODEL}", MODEL, MODEL.split("/")[-1])
})

app = FastAPI()

# ── Contexte de run mutable, partagé avec les callbacks/executors ────────────
# Une conversation OpenHands vit plusieurs tours ; ses callbacks sont figés à
# la création, donc ils lisent le contexte COURANT via cet objet mutable.
class RunCtx:
    def __init__(self) -> None:
        self.run_id: str = ""
        self.callback_url: str = ""
        self.q: "queue.Queue[dict | None]" = queue.Queue()
        self.streamed_chars: int = 0


class NodeCallbackExecutor(ToolExecutor):
    """Exécute le tool en rappelant le serveur Node (qui détient la logique)."""

    def __init__(self, ctx: RunCtx, tool_name: str) -> None:
        self.ctx = ctx
        self.tool_name = tool_name

    def __call__(self, action, conversation=None) -> ClientToolObservation:
        args = action.model_dump(exclude_none=True)
        args.pop("kind", None)  # discriminateur interne du modèle généré
        try:
            resp = httpx.post(
                self.ctx.callback_url,
                json={"run_id": self.ctx.run_id, "name": self.tool_name, "args": args},
                timeout=180.0,
            )
            if resp.status_code != 200:
                return ClientToolObservation.from_text(
                    text=json.dumps({"error": f"tool-exec HTTP {resp.status_code}: {resp.text[:200]}"})
                )
            data = resp.json()
            return ClientToolObservation.from_text(text=str(data.get("result", "")))
        except Exception as e:  # noqa: BLE001 — l'agent doit voir l'échec, pas crasher
            return ClientToolObservation.from_text(text=json.dumps({"error": str(e)}))


# Les Tool.params doivent être JSON-sérialisables (le SDK snapshot l'état de
# la conversation) — le RunCtx vivant passe donc par ce registre module,
# référencé par une simple clé string dans les params.
_CTX_REGISTRY: dict[str, RunCtx] = {}


class NodeProxyTools(ClientTool):
    """Tools construits depuis les schémas JSON envoyés par Node, avec
    l'executor de rappel à la place du no-op ClientToolExecutor."""

    @classmethod
    def create(cls, conv_state=None, **params):
        ctx = _CTX_REGISTRY[params["ctx_key"]]
        out = []
        for spec in params["specs"]:
            (base,) = ClientTool.create(spec=spec)
            out.append(base.model_copy(update={"executor": NodeCallbackExecutor(ctx, spec["name"])}))
        return out


register_tool("NodeProxyTools", NodeProxyTools)

# ── Sessions (multi-tour) ────────────────────────────────────────────────────
_sessions: dict[str, dict[str, Any]] = {}
_sessions_lock = threading.Lock()
MAX_SESSIONS = 100


def _snapshot_usage(llm: LLM) -> tuple[int, int]:
    try:
        u = llm.metrics.accumulated_token_usage
        return int(getattr(u, "prompt_tokens", 0) or 0), int(getattr(u, "completion_tokens", 0) or 0)
    except Exception:  # noqa: BLE001
        return 0, 0


def _get_or_create_session(
    session_id: str | None,
    system_prompt: str,
    tools: list[dict],
    max_iterations: int,
    reasoning_effort: str | None,
    with_images: bool = False,
) -> tuple[str, dict[str, Any]]:
    with _sessions_lock:
        if session_id and session_id in _sessions:
            return session_id, _sessions[session_id]

        sid = session_id or str(uuid.uuid4())
        ctx = RunCtx()
        _CTX_REGISTRY[sid] = ctx

        llm = LLM(
            model=f"openai/{MODEL}",
            base_url=RCP_BASE_URL,
            api_key=SecretStr(RCP_KEY),
            stream=True,
            usage_id=f"oh-{sid[:8]}",
            # Le SDK n'envoie son propre `reasoning_effort` (défaut "high") que
            # si LiteLLM croit le modèle compatible — incertain pour GLM. On le
            # neutralise et on pose "low" nous-mêmes quand la réflexion est
            # coupée ; sinon rien, le modèle réfléchit librement. Fixé à la
            # création : il vaut pour toute la session.
            reasoning_effort=None,
            litellm_extra_body={"reasoning_effort": reasoning_effort} if reasoning_effort else {},
            # Le SDK force le format « texte seul » pour tout modèle nommé
            # « glm » (limitation d'autres fournisseurs de GLM-4.5), ce qui
            # SUPPRIME les images. RCP accepte le format multimodal : on le
            # rétablit, mais seulement pour un tour qui porte une image — les
            # tours texte gardent le format éprouvé.
            force_string_serializer=False if with_images else None,
        )

        def on_token(chunk) -> None:
            try:
                for choice in chunk.choices or []:
                    d = choice.delta
                    if d is None:
                        continue
                    # Réflexion du modèle (vLLM la sépare dans reasoning_content) :
                    # transmise à part, pour le journal d'activité des frontends.
                    reasoning = getattr(d, "reasoning_content", None)
                    if isinstance(reasoning, str) and reasoning:
                        ctx.q.put({"type": "thinking_delta", "text": reasoning})
                    content = getattr(d, "content", None)
                    if isinstance(content, str) and content:
                        ctx.streamed_chars += len(content)
                        ctx.q.put({"type": "text_delta", "text": content})
            except Exception:  # noqa: BLE001
                pass

        def on_event(ev) -> None:
            try:
                if isinstance(ev, ActionEvent) and ev.source == "agent":
                    action_args = ev.action.model_dump(exclude_none=True) if ev.action else {}
                    action_args.pop("kind", None)
                    ctx.q.put({
                        "type": "tool_use",
                        "id": ev.tool_call_id,
                        "name": ev.tool_name,
                        "input": action_args,
                    })
                elif isinstance(ev, ObservationEvent):
                    obs_text = ""
                    try:
                        parts = ev.observation.to_llm_content
                        obs_text = " ".join(getattr(p, "text", "") for p in parts)
                    except Exception:  # noqa: BLE001
                        obs_text = str(ev.observation)
                    ctx.q.put({
                        "type": "tool_result",
                        "tool_use_id": ev.tool_call_id,
                        "preview": obs_text[:400],
                    })
                elif isinstance(ev, MessageEvent) and ev.source == "agent":
                    texts = [getattr(c, "text", "") for c in ev.llm_message.content]
                    full = "\n".join(t for t in texts if t)
                    if full:
                        ctx.q.put({"type": "final_message", "text": full})
            except Exception:  # noqa: BLE001
                pass

        agent = Agent(
            llm=llm,
            tools=[Tool(name="NodeProxyTools", params={"specs": tools, "ctx_key": sid})],
            include_default_tools=[],
            system_prompt=system_prompt,
        )
        conversation = Conversation(
            agent=agent,
            workspace=os.getcwd(),
            callbacks=[on_event],
            token_callbacks=[on_token],
            max_iteration_per_run=max_iterations,
            visualizer=None,
        )

        session = {"conversation": conversation, "ctx": ctx, "llm": llm}
        _sessions[sid] = session
        # Éviction LRU grossière (registre de ctx nettoyé en parallèle)
        while len(_sessions) > MAX_SESSIONS:
            evicted = next(iter(_sessions))
            _sessions.pop(evicted)
            _CTX_REGISTRY.pop(evicted, None)
        return sid, session


class RunRequest(BaseModel):
    run_id: str
    session_id: str | None = None
    system_prompt: str
    message: str
    tools: list[dict] = []
    callback_url: str
    max_iterations: int = 24
    reasoning_effort: str | None = None
    # Sans état : session neuve, jetée en fin de tour (l'historique est déjà
    # dans `message`, envoyé par le client).
    ephemeral: bool = False
    # Images jointes à la question (data URLs).
    images: list[str] = []


@app.get("/health")
def health():
    return {"status": "ok", "engine": "openhands", "model": MODEL}


@app.post("/run")
def run(req: RunRequest):
    sid, session = _get_or_create_session(
        None if req.ephemeral else req.session_id,
        req.system_prompt, req.tools, req.max_iterations, req.reasoning_effort,
        with_images=bool(req.images),
    )
    conversation: Conversation = session["conversation"]
    ctx: RunCtx = session["ctx"]
    llm: LLM = session["llm"]

    # Nouveau tour : fraîche queue + contexte de rappel courant
    ctx.q = queue.Queue()
    ctx.run_id = req.run_id
    ctx.callback_url = req.callback_url
    ctx.streamed_chars = 0

    in_before, out_before = _snapshot_usage(llm)

    def worker() -> None:
        try:
            if req.images:
                conversation.send_message(Message(role="user", content=[
                    TextContent(text=req.message),
                    ImageContent(image_urls=req.images),
                ]))
            else:
                conversation.send_message(req.message)
            conversation.run()
        except Exception as e:  # noqa: BLE001
            ctx.q.put({"type": "error", "message": str(e)})
        finally:
            if req.ephemeral:
                with _sessions_lock:
                    _sessions.pop(sid, None)
                    _CTX_REGISTRY.pop(sid, None)
            in_after, out_after = _snapshot_usage(llm)
            ctx.q.put({
                "type": "usage",
                "input": max(0, in_after - in_before),
                "output": max(0, out_after - out_before),
            })
            ctx.q.put(None)  # sentinelle de fin

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        yield json.dumps({"type": "session", "session_id": sid}) + "\n"
        final_text = ""
        streamed_any = False
        while True:
            try:
                item = ctx.q.get(timeout=600)
            except queue.Empty:
                yield json.dumps({"type": "error", "message": "timeout interne (10 min sans événement)"}) + "\n"
                break
            if item is None:
                break
            if item["type"] == "text_delta":
                streamed_any = True
            if item["type"] == "final_message":
                final_text = item["text"]
                # Ne renvoyer le bloc complet que si rien n'a été streamé
                if not streamed_any:
                    yield json.dumps({"type": "text", "text": final_text}) + "\n"
                continue
            yield json.dumps(item) + "\n"
        yield json.dumps({"type": "result", "text": final_text}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
