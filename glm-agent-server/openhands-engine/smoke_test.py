"""Smoke test : OpenHands SDK + GLM-5.2 via RCP + tool proxy à schéma JSON brut.

Valide, avant d'écrire le sidecar : la config LLM OpenAI-compatible vers RCP,
la boucle agentique avec un tool custom, le streaming token-par-token, le
system prompt custom et la désactivation des tools par défaut.
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

from pydantic import SecretStr
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.sdk.tool import ToolExecutor, register_tool
from openhands.sdk.tool.client_tool import ClientTool, ClientToolObservation

# Jamais de clé en dur : ce fichier est versionné.
RCP_KEY = os.environ["RCP_API_KEY"]

# ── Executor proxy : ici canné ; dans le sidecar ce sera un POST vers Node ──
class CannedExecutor(ToolExecutor):
    def __call__(self, action, conversation=None):
        args = action.model_dump(exclude_none=True)
        print(f"\n[TOOL EXECUTÉ] args={args}", file=sys.stderr)
        return ClientToolObservation.from_text(
            text='{"count":1,"results":[{"number":1,"doc":"La TVA à L\'EPFL","text":"Le numéro de TVA de l\'EPFL est CHE-116.075.613 TVA. Ce numéro sert aussi de numéro EORI pour les douanes."}]}'
        )

class NodeProxyTools(ClientTool):
    @classmethod
    def create(cls, conv_state=None, **params):
        out = []
        for spec in params["specs"]:
            (base,) = ClientTool.create(spec=spec)
            out.append(base.model_copy(update={"executor": CannedExecutor()}))
        return out

register_tool("NodeProxyTools", NodeProxyTools)

SPECS = [{
    "name": "search_epfl",
    "description": "Recherche dans la base de connaissances EPFL. Retourne des passages numérotés.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "La recherche"}},
        "required": ["query"],
    },
}]

llm = LLM(
    model="openai/zai-org/GLM-5.2",
    base_url="https://inference.rcp.epfl.ch/v1",
    api_key=SecretStr(RCP_KEY),
    stream=True,
    usage_id="smoke-test",
)

agent = Agent(
    llm=llm,
    tools=[Tool(name="NodeProxyTools", params={"specs": SPECS})],
    include_default_tools=[],
    system_prompt="Tu es l'assistant EPFL. Utilise search_epfl pour toute question EPFL, puis réponds en français en citant [N].",
)

streamed = []
def on_token(chunk):
    for choice in chunk.choices or []:
        d = choice.delta
        if d is not None and isinstance(getattr(d, "content", None), str):
            streamed.append(d.content)
            sys.stdout.write(d.content)
            sys.stdout.flush()
    u = getattr(chunk, "usage", None)
    if u:
        print(f"\n[USAGE] in={getattr(u,'prompt_tokens',None)} out={getattr(u,'completion_tokens',None)}", file=sys.stderr)

events = []
def on_event(ev):
    events.append(type(ev).__name__)

conversation = Conversation(
    agent=agent,
    workspace=os.getcwd(),
    callbacks=[on_event],
    token_callbacks=[on_token],
    max_iteration_per_run=8,
)
conversation.send_message("Quel est le numéro de TVA de l'EPFL ?")
conversation.run()

print("\n\n=== ÉVÉNEMENTS ===", file=sys.stderr)
print(" ".join(events), file=sys.stderr)
print(f"=== STREAMING: {len(streamed)} deltas reçus ===", file=sys.stderr)
