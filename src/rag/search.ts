/**
 * Hybrid KB search: Vectorize (semantic) + D1 FTS5 (keyword) → Reciprocal Rank Fusion → top articles.
 */
import { embedQuery } from "./embed";
import { reciprocalRankFusion } from "./rrf";

export type Os = "windows" | "macos" | "linux";

export interface SearchDeps {
  db: D1Database;
  ai: Pick<Ai, "run">;
  vectorize: Pick<VectorizeIndex, "query">;
}

export interface SearchOptions {
  /** Only return articles that apply to this OS. */
  os?: Os | null;
  /** Number of articles to return (default 5). */
  limit?: number;
}

export interface SearchHit {
  articleId: string;
  title: string;
  category: string;
  ticketCategory: string;
  priority: string;
  action: string;
  /** Best-matching chunk, used as the citation. */
  section: string;
  snippet: string;
  /** Fused RRF score (only meaningful relative to other hits). */
  score: number;
  /** Cosine similarity of the best vector match for this article, if any. */
  vectorScore: number | null;
  keywordMatch: boolean;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /**
   * False when nothing is a convincing match — the agent should say it doesn't have a guide
   * and offer a ticket instead of improvising org-specific steps.
   */
  confident: boolean;
}

/** Tuned with evals/retrieval.yaml; see evals/RESULTS.md. */
export const VECTOR_CONFIDENCE_THRESHOLD = 0.62;
const CANDIDATES = 10;

const STOPWORDS = new Set(
  "a an and are as at be but by can cant could do does doesnt dont for from get getting got has have how i im in is isnt it its keep keeps me my not of on or our please so some still that the their them there this to too was wasnt we what when where which who why will with wont you your hai hain ka ki ke ko nahi raha rahi kya mera meri mujhe se".split(
    " ",
  ),
);

/** Turns free text into a safe FTS5 query: prefix-matched terms OR'ed together. */
export function toFtsQuery(text: string): string | null {
  const terms = [
    ...new Set(
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/[\s-]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ].slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

interface ArticleRow {
  id: string;
  title: string;
  category: string;
  ticket_category: string;
  priority: string;
  action: string;
  os: string;
}

interface FtsRow {
  chunk_id: string;
  article_id: string;
  section: string;
  snippet: string;
}

export async function searchKb(deps: SearchDeps, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 5;
  const q = query.trim().slice(0, 500);
  if (!q) return { query, hits: [], confident: false };

  const ftsQuery = toFtsQuery(q);
  const filter = opts.os ? { [`os_${opts.os}`]: true } : undefined;

  const [vector, fts] = await Promise.all([
    embedQuery(deps.ai, q).then((v) => deps.vectorize.query(v, { topK: CANDIDATES, filter, returnMetadata: "none" })),
    ftsQuery
      ? deps.db
          .prepare(
            `SELECT chunk_id, article_id, section, snippet(kb_fts, 5, '', '', '…', 24) AS snippet
             FROM kb_fts WHERE kb_fts MATCH ?1
             ORDER BY bm25(kb_fts, 0, 0, 0, 6.0, 3.0, 1.0) LIMIT ?2`,
          )
          .bind(ftsQuery, CANDIDATES * 2)
          .all<FtsRow>()
          .then((r) => r.results)
      : Promise.resolve([] as FtsRow[]),
  ]);

  const articleOf = (chunkId: string) => chunkId.split("#")[0]!;
  const vectorScoreByArticle = new Map<string, number>();
  for (const m of vector.matches) {
    const a = articleOf(m.id);
    vectorScoreByArticle.set(a, Math.max(vectorScoreByArticle.get(a) ?? 0, m.score));
  }
  const ftsByChunk = new Map(fts.map((r) => [r.chunk_id, r]));

  // Fuse at chunk level, then keep each article's best chunk.
  const fused = reciprocalRankFusion([vector.matches.map((m) => m.id), fts.map((r) => r.chunk_id)]);
  const best = new Map<string, { chunkId: string; score: number }>();
  for (const f of fused) {
    const a = articleOf(f.id);
    if (!best.has(a)) best.set(a, { chunkId: f.id, score: f.score });
  }

  const ids = [...best.keys()];
  if (ids.length === 0) return { query, hits: [], confident: false };

  const rows = await deps.db
    .prepare(
      `SELECT id, title, category, ticket_category, priority, action, os FROM kb_articles WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<ArticleRow>();
  const articles = new Map(rows.results.map((r) => [r.id, r]));

  // Chunk text for citations from vector-only matches.
  const missing = [...best.values()].map((b) => b.chunkId).filter((c) => !ftsByChunk.has(c));
  const chunkText = new Map<string, string>();
  if (missing.length) {
    const r = await deps.db
      .prepare(`SELECT chunk_id, content FROM kb_fts WHERE chunk_id IN (${missing.map(() => "?").join(",")})`)
      .bind(...missing)
      .all<{ chunk_id: string; content: string }>();
    for (const row of r.results) chunkText.set(row.chunk_id, row.content);
  }

  const hits: SearchHit[] = [];
  for (const [articleId, b] of best) {
    const art = articles.get(articleId);
    if (!art) continue; // vector exists but article was deleted — skip
    if (opts.os && !(JSON.parse(art.os) as string[]).includes(opts.os)) continue;
    const ftsRow = ftsByChunk.get(b.chunkId);
    const raw = ftsRow?.snippet ?? chunkText.get(b.chunkId) ?? "";
    hits.push({
      articleId,
      title: art.title,
      category: art.category,
      ticketCategory: art.ticket_category,
      priority: art.priority,
      action: art.action,
      section: b.chunkId.split("#")[1] ?? "overview",
      snippet: raw.replace(/\s+/g, " ").trim().slice(0, 240),
      score: b.score,
      vectorScore: vectorScoreByArticle.get(articleId) ?? null,
      keywordMatch: fts.some((r) => r.article_id === articleId),
    });
    if (hits.length >= limit) break;
  }

  const top = hits[0];
  const confident = !!top && ((top.vectorScore ?? 0) >= VECTOR_CONFIDENCE_THRESHOLD || (top.keywordMatch && (top.vectorScore ?? 0) >= VECTOR_CONFIDENCE_THRESHOLD - 0.08));

  return { query, hits, confident };
}
