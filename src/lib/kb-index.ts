/**
 * Validating and indexing one KB article: D1 (article, steps, FTS) + Vectorize (one vector per
 * chunk). Shared by `pnpm kb:ingest` (local script) and KbReindexWorkflow (console edits, approved
 * proposals), so both produce exactly the same index.
 */
import { z } from "zod";
import { KB_ACTIONS, PRIORITIES } from "../db/schema";
import { fillPlaceholders, kbPlaceholders, TICKET_CATEGORIES } from "../org-config";
import { EMBEDDING_MODEL } from "../rag/embed";
import { chunkArticle, parseSections, type ArticleSections, type KbChunk } from "../rag/kb-sections";

export const articleMetaSchema = z.object({
  id: z.string().regex(/^KB-\d{3}$/, "Article ids look like KB-021"),
  title: z.string().trim().min(5).max(120),
  category: z.string().trim().min(2).max(40),
  tags: z.array(z.string().trim().min(1).max(40)).min(3, "Add at least 3 tags").max(30),
  os: z.array(z.enum(["windows", "macos", "linux"])).min(1, "Pick at least one OS"),
  ticket_category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(PRIORITIES),
  action: z.enum(KB_ACTIONS),
});
export type ArticleMeta = z.infer<typeof articleMetaSchema>;

export const articleInputSchema = articleMetaSchema.extend({ body: z.string().trim().min(40).max(20_000) });
export type ArticleInput = z.infer<typeof articleInputSchema>;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export type Validation = { ok: true; sections: ArticleSections } | { ok: false; error: string };

/** Same rules as `pnpm kb:check`: four sections in order, title matches, known placeholders, at least one step. */
export function validateArticle(a: ArticleInput): Validation {
  let sections: ArticleSections;
  try {
    sections = parseSections(a.body);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (sections.title !== a.title.trim()) return { ok: false, error: `The body's "# ${sections.title}" heading must match the title.` };
  if (!sections.steps.length) return { ok: false, error: "Add at least one numbered step under Quick fixes or Advanced steps." };
  const unknown = [...new Set([...a.body.matchAll(PLACEHOLDER)].map((m) => m[1]!))].filter((p) => !(p in kbPlaceholders));
  if (unknown.length) return { ok: false, error: `Unknown placeholders: ${unknown.map((p) => `{{${p}}}`).join(", ")}` };
  return { ok: true, sections };
}

/** FTS content doubles as the citation snippet, so the overview chunk drops its title / keywords lines. */
export const ftsContent = (c: KbChunk) =>
  c.section === "overview" ? c.text.split("\n").slice(1).filter((l) => !l.startsWith("Keywords:")).join("\n") : c.text;

export interface PreparedArticle {
  meta: ArticleMeta;
  /** Body with placeholders filled (what employees see and what's embedded). */
  body: string;
  sections: ArticleSections;
  chunks: KbChunk[];
}

export function prepareArticle(meta: ArticleMeta, rawBody: string): PreparedArticle {
  const body = fillPlaceholders(rawBody.trim());
  const sections = parseSections(body);
  return { meta, body, sections, chunks: chunkArticle(meta.id, meta.title, meta.tags, sections) };
}

export async function contentHash(meta: ArticleMeta, body: string): Promise<string> {
  const data = new TextEncoder().encode(EMBEDDING_MODEL + JSON.stringify(meta) + body);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function vectorRecords(p: PreparedArticle, vectors: number[][]): VectorizeVector[] {
  return p.chunks.map((c, i) => ({
    id: c.id,
    values: vectors[i]!,
    metadata: {
      article_id: p.meta.id,
      title: p.meta.title,
      section: c.section,
      category: p.meta.ticket_category,
      os_windows: p.meta.os.includes("windows"),
      os_macos: p.meta.os.includes("macos"),
      os_linux: p.meta.os.includes("linux"),
    },
  }));
}

/** The D1 writes for one article, as one batch (article row, steps, FTS rows). */
export function articleStatements(db: D1Database, p: PreparedArticle, hash: string, managedBy: "file" | "console", now = Date.now()): D1PreparedStatement[] {
  const { meta: m, sections, chunks } = p;
  return [
    db
      .prepare(
        `INSERT INTO kb_articles (id, title, category, tags, os, ticket_category, priority, action, body, content_hash, managed_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET title=?2, category=?3, tags=?4, os=?5, ticket_category=?6, priority=?7,
           action=?8, body=?9, content_hash=?10, managed_by=?11, updated_at=?12`,
      )
      .bind(m.id, m.title, m.category, JSON.stringify(m.tags), JSON.stringify(m.os), m.ticket_category, m.priority, m.action, p.body, hash, managedBy, now),
    db.prepare("DELETE FROM kb_steps WHERE article_id = ?").bind(m.id),
    ...sections.steps.map((s) => db.prepare('INSERT INTO kb_steps (article_id, section, "order", text) VALUES (?, ?, ?, ?)').bind(m.id, s.section, s.order, s.text)),
    db.prepare("DELETE FROM kb_fts WHERE article_id = ?").bind(m.id),
    ...chunks.map((c) =>
      db
        .prepare("INSERT INTO kb_fts (chunk_id, article_id, section, title, tags, content) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(c.id, m.id, c.section, m.title, m.tags.join(" "), ftsContent(c)),
    ),
  ];
}

/** Next free article id (KB-021, …). */
export async function nextArticleId(db: D1Database): Promise<string> {
  const rows = await db.prepare("SELECT id FROM kb_articles UNION SELECT article_id FROM kb_revisions UNION SELECT article_id FROM kb_proposals").all<{ id: string }>();
  const max = rows.results.reduce((n, r) => Math.max(n, Number(r.id.match(/^KB-(\d{3})$/)?.[1] ?? 0)), 0);
  return `KB-${String(max + 1).padStart(3, "0")}`;
}
