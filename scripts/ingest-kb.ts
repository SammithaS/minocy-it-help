/**
 * Ingests kb/*.md into D1 (articles, steps, FTS5) and Vectorize (embeddings from Workers AI).
 *
 *   pnpm kb:ingest            # local D1 + your Cloudflare account's Vectorize/Workers AI
 *   pnpm kb:ingest --force    # re-embed everything, and overwrite articles edited in the console
 *   pnpm kb:ingest --remote   # also copy the KB rows to the deployed (remote) D1 — see README → Deploy
 *
 * Runs locally (not in a Worker request) because chunking + embedding 20 articles would blow the
 * Free plan's per-request CPU budget. Idempotent: articles whose content hash hasn't changed are
 * skipped; articles removed from kb/ are deleted. Articles edited in the console KB editor
 * (managed_by = "console") are left alone unless --force — the console version is newer.
 * Uses the same indexing code as KbReindexWorkflow (src/lib/kb-index.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { articleStatements, contentHash, prepareArticle, vectorRecords } from "../src/lib/kb-index";
import { embedPassages } from "../src/rag/embed";
import { parseArticle, readKbDir, unknownPlaceholders } from "./lib/kb-parse";

const force = process.argv.includes("--force");
const remote = process.argv.includes("--remote");

/**
 * --remote: after the normal (local) ingest — which also upserts the shared Vectorize index — copy the
 * KB rows (articles, steps, full-text index) from local D1 to the production D1 with
 * `wrangler d1 execute --remote --file`. Overwrites production KB rows, including console edits.
 */
async function copyKbToRemote(db: D1Database) {
  const cfg = readFileSync("wrangler.jsonc", "utf8");
  if (/"database_id":\s*"00000000/.test(cfg)) throw new Error("Set the real D1 database_id in wrangler.jsonc first (README → Deploy).");
  const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const rows = async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;
  const insert = (table: string, r: Record<string, unknown>) => `INSERT INTO ${table} (${Object.keys(r).map((k) => `"${k}"`).join(", ")}) VALUES (${Object.values(r).map(q).join(", ")});`;
  const sql = [
    "DELETE FROM kb_fts;",
    "DELETE FROM kb_steps;",
    "DELETE FROM kb_articles;",
    ...(await rows("SELECT * FROM kb_articles")).map((r) => insert("kb_articles", r)),
    ...(await rows('SELECT article_id, section, "order", text FROM kb_steps')).map((r) => insert("kb_steps", r)),
    ...(await rows("SELECT chunk_id, article_id, section, title, tags, content FROM kb_fts")).map((r) => insert("kb_fts", r)),
  ];
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(".wrangler/kb-remote.sql", sql.join("\n") + "\n");
  console.log(`→ copying ${sql.length - 3} KB rows to the REMOTE D1 database`);
  const r = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--yes", "--file=.wrangler/kb-remote.sql"], { stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error("wrangler d1 execute --remote failed");
}

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
  if (remote) await copyKbToRemote(env.DB);
} finally {
  await dispose();
}
