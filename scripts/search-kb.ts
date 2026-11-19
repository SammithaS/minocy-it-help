/**
 * Debug the hybrid search from the terminal.
 *   pnpm kb:search "wifi keeps dropping" [--os windows]
 */
import { getPlatformProxy } from "wrangler";
import { searchKb, type Os } from "../src/rag/search";

const args = process.argv.slice(2);
const osIdx = args.indexOf("--os");
const os = osIdx >= 0 ? (args.splice(osIdx, 2)[1] as Os) : null;
const query = args.join(" ");
if (!query) {
  console.error('Usage: pnpm kb:search "your question" [--os windows|macos|linux]');
  process.exit(1);
}

const { env, dispose } = await getPlatformProxy<{ DB: D1Database; AI: Ai; VECTORIZE: VectorizeIndex }>({ configPath: "wrangler.jsonc" });
try {
  const r = await searchKb({ db: env.DB, ai: env.AI, vectorize: env.VECTORIZE }, query, { os });
  console.log(`"${query}"${os ? ` (os=${os})` : ""} → confident=${r.confident}`);
  console.table(
    r.hits.map((h) => ({
      id: h.articleId,
      title: h.title.slice(0, 40),
      section: h.section,
      rrf: h.score.toFixed(4),
      vector: h.vectorScore?.toFixed(3) ?? "-",
      keyword: h.keywordMatch,
    })),
  );
} finally {
  await dispose();
}
