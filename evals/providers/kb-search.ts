/**
 * promptfoo provider: runs the real hybrid search (src/rag/search.ts) against local D1 +
 * your Cloudflare account's Vectorize and Workers AI, via Wrangler's platform proxy.
 * Output is JSON: { ids, confident, top }.
 */
import { getPlatformProxy } from "wrangler";
import { searchKb } from "../../src/rag/search";

type ProxyEnv = { DB: D1Database; AI: Ai; VECTORIZE: VectorizeIndex };
let proxy: ReturnType<typeof getPlatformProxy<ProxyEnv>> | undefined;

export default class KbSearchProvider {
  id() {
    return "kb-hybrid-search";
  }

  async callApi(prompt: string) {
    proxy ??= getPlatformProxy<ProxyEnv>({ configPath: "wrangler.jsonc" });
    const { env } = await proxy;
    const started = Date.now();
    const r = await searchKb({ db: env.DB, ai: env.AI, vectorize: env.VECTORIZE }, prompt, { limit: 5 });
    return {
      output: JSON.stringify({
        ids: r.hits.map((h) => h.articleId),
        confident: r.confident,
        top: r.hits[0] ? { id: r.hits[0].articleId, vectorScore: r.hits[0].vectorScore, keyword: r.hits[0].keywordMatch } : null,
      }),
      latencyMs: Date.now() - started,
    };
  }
}
