/**
 * Serveur HTTP du POC.
 *
 *   GET  /health          → statut
 *   POST /chat            → SSE ; body JSON :
 *     {
 *       "message":    "question de l'utilisateur",
 *       "graphToken": "token Graph (MSAL, transmis par l'add-in)",
 *       "history":    [{role, content}, …] — mode SANS ÉTAT (recommandé),
 *       "refs":       table des refs email renvoyée au tour précédent,
 *       "images":     ["data:image/…"] — images jointes à la question,
 *       "sessionId":  "ancien mode — reprise d'une session gardée en mémoire"
 *     }
 *
 * Sans état : dès que `history` est présent, le serveur ne garde RIEN entre
 * deux tours — l'historique vient du client, la table des refs aussi (renvoyée
 * par l'événement `refs` en fin de tour). C'est ce qui permet plusieurs
 * réplicas et survit aux redémarrages. `sessionId` reste accepté le temps que
 * tous les frontends passent au mode sans état.
 *
 * Événements SSE : session, text, text_delta, thinking_delta, tool_use,
 * tool_result, refs, result, error.
 */
import http from "node:http";
import { config } from "./config.js";
import { startRcpProxy } from "./rcpProxy.js";
import { runAgent } from "./agent.js";
import { RefStore } from "./emailRefs.js";
import { withHistory } from "./history.js";
import { runOpenHandsAgent, executeToolForRun } from "./openhandsEngine.js";
import { validateEntraIdToken } from "./entraJwt.js";
import { resolveClientToolCall, type ClientToolDef } from "./clientTools.js";

// CORS : origines autorisées — dev local + prod (même origine en prod, mais le
// header ne coûte rien). Extensible via CORS_ORIGINS (liste séparée par virgules).
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ||
    "https://localhost:3000,https://expert-finder.epfl.ch,https://personal-rag.epfl.ch,http://localhost:8000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  // Les extensions navigateur (profil dpo) ont une origine chrome-extension://
  // — autorisées telles quelles : l'accès réel est gardé par les tokens.
  const allowed =
    origin && (ALLOWED_ORIGINS.has(origin) || origin.startsWith("chrome-extension://"))
      ? origin
      : [...ALLOWED_ORIGINS][0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Le cookie d'affinité de l'ingress (plusieurs réplicas) doit accompagner
    // le POST /tool-result jusqu'au pod qui attend le résultat.
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

/**
 * Garde d'authentification pour l'exposition en ligne : le token Graph transmis
 * doit être VALIDE (vérifié via GET /me) avant de lancer l'agent. Sans ça,
 * n'importe qui pourrait consommer la clé RCP du serveur avec un token bidon.
 */
async function validateGraphToken(token: string): Promise<boolean> {
  try {
    const resp = await fetch("https://graph.microsoft.com/v1.0/me?$select=id", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const CORS = corsHeaders(req);
  let body: {
    message?: string;
    profile?: string;
    engine?: string;
    graphToken?: string;
    sessionId?: string;
    currentEmail?: { id: string; subject?: string; from?: string };
    kbToken?: string;
    clientTools?: ClientToolDef[];
    thinking?: boolean;
    history?: Array<{ role?: string; content?: unknown }>;
    refs?: unknown;
    images?: unknown;
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: "Body JSON invalide" }));
    return;
  }
  const profile = body.profile === "dpo" ? "dpo" : "outlook";
  if (!body.message) {
    res.writeHead(400, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: "Champ requis : message" }));
    return;
  }

  // Garde d'authentification (le serveur est en ligne : sans elle, n'importe
  // qui consommerait la clé RCP). Par profil :
  //  - outlook : token Graph délégué, vérifié via GET /me
  //  - dpo     : id_token Entra, vérifié par signature/issuer/audience (JWKS)
  if (profile === "outlook") {
    if (!body.graphToken || !(await validateGraphToken(body.graphToken))) {
      res.writeHead(401, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: "Token Graph invalide ou expiré — reconnecte-toi dans l'onglet Config." }));
      return;
    }
  } else {
    const who = body.kbToken ? await validateEntraIdToken(body.kbToken) : null;
    if (!who) {
      res.writeHead(401, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: "id_token Entra invalide ou expiré — reconnecte-toi dans l'extension." }));
      return;
    }
    console.log(`[server] /chat dpo — ${who}`);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...CORS,
  });

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  // Heartbeat SSE : évite que l'ingress/proxies coupent la connexion pendant
  // les phases silencieuses (collecte Graph, embeddings…).
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connexion fermée */
    }
  }, 15000);

  // Moteur d'agent : OpenHands (MIT) par défaut depuis le 24.09.2026 ; le
  // harness Claude Code (propriétaire) ne sert plus que sur demande explicite
  // (`engine: "claude-code"`), pour comparer. Même boîte à outils et même
  // contrat SSE des deux côtés.
  const engine = body.engine === "claude-code" ? "claude-code" : "openhands";
  const runEngine = engine === "openhands" ? runOpenHandsAgent : runAgent;

  const stateless = Array.isArray(body.history);
  const refStore = stateless ? RefStore.fromJSON(body.refs) : undefined;
  const images = Array.isArray(body.images)
    ? body.images.filter((u): u is string => typeof u === "string" && u.startsWith("data:image/"))
    : [];
  const message = stateless ? withHistory(body.message, body.history!) : body.message;

  console.log(
    `[server] /chat [${engine}/${profile}]: "${body.message.slice(0, 80)}"` +
      (stateless ? ` (sans état, ${body.history!.length} msg d'historique${images.length ? `, ${images.length} image(s)` : ""})` : "") +
      (!stateless && body.sessionId ? ` (resume ${body.sessionId})` : ""),
  );

  // Les tools peuvent pousser des événements UI (email_list…) directement
  // dans le flux SSE, sans passer par le contexte LLM.
  const emitUi = (eventType: string, data: Record<string, unknown>) => {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const event of runEngine({
      message,
      profile,
      graphToken: body.graphToken,
      sessionId: body.sessionId,
      currentEmail: body.currentEmail?.id ? body.currentEmail : undefined,
      kbToken: body.kbToken || undefined,
      clientTools: Array.isArray(body.clientTools) ? body.clientTools : undefined,
      thinking: body.thinking !== false,
      stateless,
      refStore,
      images,
      abortController,
      emitUi,
    })) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if (event.type === "text") {
        console.log(`[agent] ${String(event.data.text).slice(0, 120)}`);
      } else if (event.type === "tool_use") {
        console.log(`[agent] → tool ${event.data.name}(${JSON.stringify(event.data.input).slice(0, 150)})`);
      }
    }
    // Sans état : le client garde la table des refs pour le tour suivant.
    if (refStore && profile === "outlook") {
      res.write(`event: refs\ndata: ${JSON.stringify(refStore.toJSON())}\n\n`);
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
  } finally {
    clearInterval(heartbeat);
  }
  res.end();
}

async function main() {
  await startRcpProxy();

  const server = http.createServer((req, res) => {
    // Derrière l'ingress k8s, le service est servi sous /outlook/agent/* —
    // on accepte les deux formes (avec et sans préfixe) sans middleware traefik.
    const path = (req.url || "").replace(/^\/outlook\/agent(?=\/|$)/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...corsHeaders(req) });
      res.end(JSON.stringify({ status: "ok", model: config.rcp.model }));
      return;
    }
    if (req.method === "POST" && path === "/chat") {
      void handleChat(req, res);
      return;
    }
    if (req.method === "POST" && path === "/internal/tool-exec") {
      // Canal interne du sidecar OpenHands : exécute un tool du run courant.
      // STRICTEMENT localhost — jamais exposé via l'ingress (et l'IP source
      // d'une requête ingress ne serait de toute façon pas loopback).
      const remote = req.socket.remoteAddress || "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        res.writeHead(403);
        res.end();
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as {
            run_id?: string;
            name?: string;
            args?: Record<string, unknown>;
          };
          if (!body.run_id || !body.name) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "run_id et name requis" }));
            return;
          }
          const outcome = await executeToolForRun(body.run_id, body.name, body.args || {});
          res.writeHead(outcome.ok ? 200 : 404, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: outcome.result }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
      return;
    }
    if (req.method === "POST" && path === "/tool-result") {
      // Réponse du frontend à un client_tool_request (tools exécutés côté client)
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as { call_id?: string; result?: unknown; is_error?: boolean };
          const resultStr = typeof body.result === "string" ? body.result : JSON.stringify(body.result ?? null);
          const found = body.call_id ? resolveClientToolCall(body.call_id, resultStr, !!body.is_error) : false;
          res.writeHead(found ? 200 : 404, { "content-type": "application/json", ...corsHeaders(req) });
          res.end(JSON.stringify({ ok: found }));
        } catch {
          res.writeHead(400, corsHeaders(req));
          res.end();
        }
      })();
      return;
    }
    res.writeHead(404, corsHeaders(req));
    res.end();
  });

  server.listen(config.port, () => {
    console.log(`[server] glm-agent-server sur http://localhost:${config.port} — modèle ${config.rcp.model}`);
  });
}

void main();
