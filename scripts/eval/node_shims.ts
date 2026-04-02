/**
 * Browser global shims for running add-in code in Node.js.
 * Must be loaded BEFORE any src/ imports.
 */

import * as fs from "fs";
import * as path from "path";

// config.ts uses window.location
(globalThis as any).window = {
  location: { origin: "https://localhost:3000", pathname: "/taskpane.html", hostname: "localhost" },
};

// rcpApiService uses localStorage
(globalThis as any).localStorage = {
  _store: {} as Record<string, string>,
  getItem(k: string) { return this._store[k] ?? null; },
  setItem(k: string, v: string) { this._store[k] = v; },
  removeItem(k: string) { delete this._store[k]; },
};

// Load .env
const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [key, ...rest] = trimmed.split("=");
      process.env[key.trim()] ??= rest.join("=").trim();
    }
  }
}

// Inject RCP settings into localStorage
const rcpUrl = process.env.RCP_API_URL || "https://inference.rcp.epfl.ch/v1";
const rcpKey = process.env.RCP_API_KEY || "";
(globalThis as any).localStorage.setItem("rcp_api_url", rcpUrl);
(globalThis as any).localStorage.setItem("rcp_api_key", rcpKey);

export { rcpUrl, rcpKey };
