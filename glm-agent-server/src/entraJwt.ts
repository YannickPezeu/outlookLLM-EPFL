/**
 * Validation d'id_token Entra ID (EPFL) — pour les profils sans token Graph
 * (profil "dpo" : l'extension n'a qu'un id_token OIDC).
 *
 * Même modèle que Hierarchical_search/src/auth : signature via JWKS du tenant,
 * issuer strict, audience dans une allowlist d'apps EPFL connues.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const ENTRA_TENANT = "f6c2556a-c4fb-4ab1-a2c7-9e220df11c43";
const EXPECTED_ISS = `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`;
const JWKS_URI = `https://login.microsoftonline.com/${ENTRA_TENANT}/discovery/v2.0/keys`;

// Apps EPFL autorisées (mêmes clients que l'allowlist de hierarchical-search)
const EXPECTED_AUDIENCES = (process.env.ENTRA_AUDIENCES ||
  [
    "7ecc1fc6-2d9b-4bf6-aed9-12a396c9039c", // EPFL Mail AI (add-in Outlook)
    "fe9b7ccb-d941-4853-bd4c-eb9487d29032", // DPO-Agent (Personal RAG)
    "c24dbdf0-fa7c-407e-9294-255e856d8dc7", // ServiceNow Chrome extension
    "1b6e8cb5-47a5-4cfa-86b4-297edb92ea08", // plugin-site-epfl
  ].join(","))
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

const jwks = createRemoteJWKSet(new URL(JWKS_URI));

/** Vérifie signature + issuer + audience. Retourne l'email/upn ou null si invalide. */
export async function validateEntraIdToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: EXPECTED_ISS,
      audience: EXPECTED_AUDIENCES,
    });
    return (payload.preferred_username as string) || (payload.email as string) || (payload.oid as string) || "unknown";
  } catch (err) {
    console.warn(`[auth] id_token Entra rejeté: ${(err as Error).message}`);
    return null;
  }
}
