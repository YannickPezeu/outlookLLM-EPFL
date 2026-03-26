import { config } from "../config";

// ─── Types ───────────────────────────────────────────────────────────

export interface EmbeddingResult {
  index: number;
  embedding: number[];
}

interface EmbeddingResponse {
  data: EmbeddingResult[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ─── RCP Embedding Client ───────────────────────────────────────────

function getRcpConfig() {
  const storedUrl = localStorage.getItem("rcp_base_url");
  const storedKey = localStorage.getItem("rcp_api_key");

  return {
    baseUrl: storedUrl || config.rcp.baseUrl,
    apiKey: storedKey || config.rcp.apiKey,
  };
}

/**
 * Batch embed multiple texts via the RCP API (OpenAI-compatible /v1/embeddings).
 * Supports batches of up to ~2000 texts in a single call.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée.");
  }

  if (texts.length === 0) return [];

  const response = await fetch(`${cfg.baseUrl}${config.rcp.embeddingsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: config.rcp.embeddingModel,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP Embedding API error ${response.status}: ${errorText}`);
  }

  const result: EmbeddingResponse = await response.json();

  // Sort by index to maintain order
  const sorted = result.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

// ─── Cosine Similarity ──────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Rank items by cosine similarity to a query embedding.
 * Returns indices sorted by descending similarity, with their scores.
 */
export function rankBySimilarity(
  queryEmbedding: number[],
  itemEmbeddings: number[][]
): Array<{ index: number; score: number }> {
  const scores = itemEmbeddings.map((emb, index) => ({
    index,
    score: cosineSimilarity(queryEmbedding, emb),
  }));

  return scores.sort((a, b) => b.score - a.score);
}
