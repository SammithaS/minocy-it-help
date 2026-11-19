/**
 * Ingests kb/*.md into D1 (articles, steps, FTS5) and Vectorize (embeddings from Workers AI).
 *
 *   pnpm kb:ingest            # local D1 + your Cloudflare account's Vectorize/Workers AI
 *   pnpm kb:ingest --force    # re-embed everything even if unchanged
 *
 * Runs locally (not in a Worker request) because chunking + embedding 20 articles would blow the
 * Free plan's per-request CPU budget. Idempotent: articles whose content hash hasn't changed are
 * skipped; articles removed from kb/ are deleted from D1 and Vectorize.
 */
import { createHash } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { fillPlaceholders } from "../src/org-config";
import { EMBEDDING_MODEL, embedPassages } from "../src/rag/embed";
import { chunkArticle, parseSections, type KbChunk } from "../src/rag/kb-sections";
import { parseArticle, readKbDir, unknownPlaceholders } from "./lib/kb-parse";

const force = process.argv.includes("--force");

/**
 * FTS content doubles as the citation snippet shown to employees, so drop the title line and the
 * "Keywords:" line from the overview chunk — both are already indexed in the title/tags columns.
 */
const ftsContent = (c: KbChunk) =>
  c.section === "overview" ? c.text.split("\n").slice(1).filter((l) => !l.startsWith("Keywords:")).join("\n") : c.text;

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
    (await env.DB.prepare("SELECT id, content_hash FROM kb_articles").all<{ id: string; content_hash: string }>()).results.map(
      (r) => [r.id, r.content_hash],
    ),
  );

  let changed = 0;
  for (const a of articles) {
    const body = fillPlaceholders(a.body);
    const hash = createHash("sha256").update(EMBEDDING_MODEL).update(JSON.stringify(a.meta)).update(body).digest("hex");
    if (!force && existing.get(a.meta.id) === hash) continue;
    changed++;

    const sections = parseSections(body);
    const chunks = chunkArticle(a.meta.id, a.meta.title, a.meta.tags, sections);
    const vectors = await embedPassages(env.AI, chunks.map((c) => c.text));

    await env.VECTORIZE.upsert(
      chunks.map((c, i) => ({
        id: c.id,
        values: vectors[i]!,
        metadata: {
          article_id: a.meta.id,
          title: a.meta.title,
          section: c.section,
          category: a.meta.ticket_category,
          os_windows: a.meta.os.includes("windows"),
          os_macos: a.meta.os.includes("macos"),
          os_linux: a.meta.os.includes("linux"),
        },
      })),
    );

    const id = a.meta.id;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO kb_articles (id, title, category, tags, os, ticket_category, priority, action, body, content_hash, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET title=?2, category=?3, tags=?4, os=?5, ticket_category=?6, priority=?7,
           action=?8, body=?9, content_hash=?10, updated_at=?11`,
      ).bind(
        id,
        a.meta.title,
        a.meta.category,
        JSON.stringify(a.meta.tags),
        JSON.stringify(a.meta.os),
        a.meta.ticket_category,
        a.meta.priority,
        a.meta.action,
        body,
        hash,
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM kb_steps WHERE article_id = ?").bind(id),
      ...sections.steps.map((s) =>
        env.DB.prepare('INSERT INTO kb_steps (article_id, section, "order", text) VALUES (?, ?, ?, ?)').bind(id, s.section, s.order, s.text),
      ),
      env.DB.prepare("DELETE FROM kb_fts WHERE article_id = ?").bind(id),
      ...chunks.map((c) =>
        env.DB.prepare("INSERT INTO kb_fts (chunk_id, article_id, section, title, tags, content) VALUES (?, ?, ?, ?, ?, ?)").bind(
          c.id,
          id,
          c.section,
          a.meta.title,
          a.meta.tags.join(" "),
          ftsContent(c),
        ),
      ),
    ]);
    console.log(`  ↑ ${id} ${a.meta.title} (${chunks.length} chunks, ${sections.steps.length} steps)`);
  }

  // Remove articles that no longer exist in kb/.
  const current = new Set(articles.map((a) => a.meta.id));
  const removed = [...existing.keys()].filter((id) => !current.has(id));
  for (const id of removed) {
    await env.VECTORIZE.deleteByIds(["overview", "quick", "advanced", "escalate"].map((s) => `${id}#${s}`));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kb_fts WHERE article_id = ?").bind(id),
      env.DB.prepare("DELETE FROM kb_steps WHERE article_id = ?").bind(id),
      env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(id),
    ]);
    console.log(`  ✗ ${id} removed`);
  }

  console.log(
    `✓ ${articles.length} articles: ${changed} ingested, ${articles.length - changed} unchanged, ${removed.length} removed.` +
      (changed ? " Vectorize applies upserts asynchronously — allow a few seconds before searching." : ""),
  );
} finally {
  await dispose();
}
