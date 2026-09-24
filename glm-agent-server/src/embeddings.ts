/**
 * Embeddings + cosine similarity via RCP — port minimal de embeddingService.ts.
 * Utilisé par le mode `query` de get_email_interactions (tri sémantique).
 */
import { config } from "./config.js";

const BATCH_SIZE = 64;
const MAX_CHARS = 4000;

async function embedBatch(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`https://${config.rcp.host}/v1/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.rcp.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.rcp.embeddingModel,
      input: texts.map((t) => t.slice(0, MAX_CHARS)),
    }),
  });
  if (!resp.ok) {
    throw new Error(`RCP embeddings error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = (await resp.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function batchEmbed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function rankBySimilarity(queryEmbedding: number[], itemEmbeddings: number[][]) {
  return itemEmbeddings
    .map((emb, index) => ({ index, score: cosine(queryEmbedding, emb) }))
    .sort((a, b) => b.score - a.score);
}
