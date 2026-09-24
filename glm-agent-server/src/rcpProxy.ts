/**
 * Mini-proxy interne : format Anthropic (/v1/messages) -> RCP LiteLLM.
 *
 * Pourquoi : le harness Claude Code envoie des paramètres Anthropic-only
 * (context_management pour la micro-compaction, cache_control, ...) que le
 * backend vLLM derrière LiteLLM rejette en 400 (UnsupportedParamsError).
 * On les strip ici avant de forwarder ; la réponse (SSE ou JSON) est streamée
 * telle quelle.
 *
 * Écoute UNIQUEMENT sur 127.0.0.1 — c'est un composant interne du pod/process,
 * jamais exposé.
 */
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { REASONING_HEADER } from "./agent.js";

// Paramètres Anthropic que LiteLLM -> vLLM ne supporte pas
const STRIP_PARAMS = [
  "context_management",
  "cache_control",
  "mcp_servers",
  "container",
  "fallbacks",
  "speed",
];

export function startRcpProxy(): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      // Réglage de réflexion posé par agent.ts (ANTHROPIC_CUSTOM_HEADERS).
      const effort = req.headers[REASONING_HEADER];

      if (body.length > 0 && (req.headers["content-type"] || "").includes("json")) {
        try {
          const json = JSON.parse(body.toString("utf8"));
          const stripped: string[] = [];
          for (const p of STRIP_PARAMS) {
            if (p in json) {
              delete json[p];
              stripped.push(p);
            }
          }
          if (stripped.length) {
            console.log(`[rcp-proxy] ${req.url} — stripped: ${stripped.join(", ")}`);
          }
          if (typeof effort === "string" && effort) json.reasoning_effort = effort;
          body = Buffer.from(JSON.stringify(json), "utf8");
        } catch {
          /* pas du JSON — forward tel quel */
        }
      }

      const headers: http.OutgoingHttpHeaders = {
        ...req.headers,
        host: config.rcp.host,
        "content-length": Buffer.byteLength(body),
      };
      delete headers["accept-encoding"]; // évite gzip, plus simple à streamer
      delete headers[REASONING_HEADER]; // interne, ne sort pas vers RCP

      const upstream = https.request(
        { host: config.rcp.host, path: req.url, method: req.method, headers },
        (up) => {
          console.log(`[rcp-proxy] ${req.method} ${req.url} -> ${up.statusCode}`);
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        }
      );
      upstream.on("error", (e) => {
        console.error(`[rcp-proxy] upstream error: ${e.message}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: e.message } }));
      });
      upstream.end(body);
    });
  });

  return new Promise((resolve) => {
    server.listen(config.proxyPort, "127.0.0.1", () => {
      console.log(
        `[rcp-proxy] 127.0.0.1:${config.proxyPort} -> https://${config.rcp.host}`
      );
      resolve();
    });
  });
}
