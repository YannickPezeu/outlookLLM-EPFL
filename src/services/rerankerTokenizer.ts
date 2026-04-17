/**
 * Lazy-loaded XLM-RoBERTa tokenizer for BAAI/bge-reranker-v2-m3.
 *
 * Used only when the rerank API rejects a request for being too long.
 * The tokenizer (~5 MB) is downloaded on first call and cached.
 */

let tokenizerPromise: Promise<unknown> | null = null;

async function loadTokenizer(): Promise<unknown> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const { AutoTokenizer } = await import("@huggingface/transformers");
      console.log("[RerankerTokenizer] Loading BAAI/bge-reranker-v2-m3 tokenizer...");
      const tok = await AutoTokenizer.from_pretrained("BAAI/bge-reranker-v2-m3");
      console.log("[RerankerTokenizer] Loaded.");
      return tok;
    })();
  }
  return tokenizerPromise;
}

export async function countTokens(text: string): Promise<number> {
  const tok = await loadTokenizer() as { encode(s: string): number[] };
  return tok.encode(text).length;
}

export async function truncateToTokens(text: string, maxTokens: number): Promise<string> {
  const tok = await loadTokenizer() as {
    encode(s: string): number[];
    decode(ids: number[], opts?: { skip_special_tokens?: boolean }): string;
  };
  const ids = tok.encode(text);
  if (ids.length <= maxTokens) return text;
  return tok.decode(ids.slice(0, maxTokens), { skip_special_tokens: true });
}
