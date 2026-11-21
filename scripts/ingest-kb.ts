/**
 * Ingests kb/*.md into D1 (articles, steps, FTS5) and Vectorize (embeddings from Workers AI).
 *
 *   pnpm kb:ingest            # local D1 + your Cloudflare account's Vectorize/Workers AI
 *   pnpm kb:ingest --force    # re-embed everything, and overwrite articles edited in the console
 *
 * Runs locally (not in a Worker request) because chunking + embedding 20 articles would blow the
 * Free plan's per-request CPU budget. Idempotent: articles whose content hash hasn't changed are
 * skipped; articles removed from kb/ are deleted. Articles edited in the console KB editor
 * (managed_by = "console") are left alone unless --force — the console version is newer.
 * Uses the same indexing code as KbReindexWorkflow (src/lib/kb-index.ts).
 */
import { getPlatformProxy } from "wrangler";
import { articleStatements, contentHash, prepareArticle, vectorRecords } from "../src/lib/kb-index";
import { embedPassages } from "../src/rag/embed";
import { parseArticle, readKbDir, unknownPlaceholders } from "./lib/kb-parse";

const force = process.argv.includes("--force");

type ProxyEnv = { DB: D1Database; AI: Ai; VECTORIZE: VectorizeIndex };
const { env, dispose } = await getPlatformProxy<ProxyEnv>({ configPath: "wrangler.jsonc" });

try {
  const files = readKbDir();
  const articles = files.map(({ file, source }) => {
    const a = parseArticle(source, file);
    const unknown = unknownPlaceholders(a);
    if (unknown.length) throw new Error(`${file}: unknown placeholders ${unknown.join(", ")}`);
    return a;
  });

  const existing = new Map(
    (await env.DB.prepare("SELECT id, content_hash, managed_by FROM kb_articles").all<{ id: string; content_hash: string; managed_by: string }>()).results.map((r) => [r.id, r]),
  );

  let changed = 0;
  const keptConsole: string[] = [];
  for (const a of articles) {
    const prev = existing.get(a.meta.id);
    if (prev?.managed_by === "console" && !force) {
      keptConsole.push(a.meta.id);
      continue;
    }
    const p = prepareArticle(a.meta, a.body);
    const hash = await contentHash(p.meta, p.body);
    if (!force && prev?.content_hash === hash) continue;
    changed++;

    const vectors = await embedPassages(env.AI, p.chunks.map((c) => c.text));
    await env.VECTORIZE.upsert(vectorRecords(p, vectors));
    await env.DB.batch(articleStatements(env.DB, p, hash, "file"));
    console.log(`  ↑ ${a.meta.id} ${a.meta.title} (${p.chunks.length} chunks, ${p.sections.steps.length} steps)`);
  }

  // Remove articles that no longer exist in kb/ (console-created articles have no file — keep them).
  const current = new Set(articles.map((a) => a.meta.id));
  const removed = [...existing.values()].filter((r) => !current.has(r.id) && r.managed_by !== "console").map((r) => r.id);
  for (const id of removed) {
    await env.VECTORIZE.deleteByIds(["overview", "quick", "advanced", "escalate"].map((s) => `${id}#${s}`));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kb_fts WHERE article_id = ?").bind(id),
      env.DB.prepare("DELETE FROM kb_steps WHERE article_id = ?").bind(id),
      env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(id),
    ]);
    console.log(`  ✗ ${id} removed`);
  }

  if (keptConsole.length) console.log(`  • kept console edits for ${keptConsole.join(", ")} (use --force to overwrite with kb/*.md)`);
  console.log(
    `✓ ${articles.length} articles: ${changed} ingested, ${articles.length - changed - keptConsole.length} unchanged, ${removed.length} removed.` +
      (changed ? " Vectorize applies upserts asynchronously — allow a few seconds before searching." : ""),
  );
} finally {
  await dispose();
}
