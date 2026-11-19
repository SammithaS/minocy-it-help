/**
 * Parses kb/*.md articles (frontmatter + sections). Used by `pnpm kb:check` and `pnpm kb:ingest`.
 */
import matter from "gray-matter";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { kbPlaceholders, TICKET_CATEGORIES } from "../../src/org-config";
import { parseSections, type ArticleSections } from "../../src/rag/kb-sections";

export const frontmatterSchema = z.object({
  id: z.string().regex(/^KB-\d{3}$/),
  title: z.string().min(5),
  category: z.string().min(2),
  tags: z.array(z.string()).min(3),
  os: z.array(z.enum(["windows", "macos", "linux"])).min(1),
  ticket_category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  action: z.enum(["troubleshoot", "how_to", "password_reset", "access_request"]),
});
export type KbFrontmatter = z.infer<typeof frontmatterSchema>;

export interface ParsedArticle {
  file: string;
  source: string;
  meta: KbFrontmatter;
  /** Markdown body with placeholders left as-is. */
  body: string;
  sections: ArticleSections;
  placeholders: string[];
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export function parseArticle(source: string, file = "<inline>"): ParsedArticle {
  const { data, content } = matter(source);
  const meta = frontmatterSchema.parse(data);
  const body = content.trim();
  const sections = parseSections(body);
  if (sections.title !== meta.title) throw new Error(`'# ${sections.title}' doesn't match frontmatter title`);
  return {
    file,
    source,
    meta,
    body,
    sections,
    placeholders: [...new Set([...source.matchAll(PLACEHOLDER)].map((m) => m[1]!))],
  };
}

export const unknownPlaceholders = (a: ParsedArticle) => a.placeholders.filter((p) => !(p in kbPlaceholders));

export function readKbDir(dir = "kb"): { file: string; source: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }));
}
