/** Workers AI embeddings (bge-base-en-v1.5, 768 dims) for KB passages and user queries. */

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMS = 768;

/** bge v1.5 retrieves better when short queries carry this instruction; passages don't. */
const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

type EmbeddingAi = Pick<Ai, "run">;

/** Retries transient Workers AI failures (e.g. InferenceUpstreamError) with backoff. */
async function runWithRetry(ai: EmbeddingAi, text: string[], attempts = 3): Promise<unknown> {
  for (let i = 1; ; i++) {
    try {
      return await ai.run(EMBEDDING_MODEL, { text });
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** i));
    }
  }
}

async function embed(ai: EmbeddingAi, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = (await runWithRetry(ai, texts.slice(i, i + 50))) as { data?: number[][] };
    if (!res.data || res.data.length !== Math.min(50, texts.length - i)) {
      throw new Error("Workers AI returned no embeddings");
    }
    out.push(...res.data);
  }
  return out;
}

export const embedPassages = (ai: EmbeddingAi, texts: string[]) => embed(ai, texts);

export async function embedQuery(ai: EmbeddingAi, query: string): Promise<number[]> {
  const [v] = await embed(ai, [QUERY_INSTRUCTION + query]);
  return v!;
}
