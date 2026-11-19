/**
 * Parses kb/*.md articles. Shared by `pnpm kb:check` (now) and `pnpm kb:ingest` (Phase 2).
 */
import matter from "gray-matter";
import { z } from "zod";
import { kbPlaceholders, TICKET_CATEGORIES } from "../../src/org-config";

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

export const SECTION_ORDER = ["Symptoms", "Quick fixes", "Advanced steps", "Escalate when"] as const;
type SectionName = (typeof SECTION_ORDER)[number];

export interface KbStep {
  section: "quick" | "advanced";
  order: number;
  text: string;
}

export interface ParsedArticle {
  meta: KbFrontmatter;
  /** Markdown body with placeholders left as-is. */
  body: string;
  /** Text before the first `##` (title + intro). */
  intro: string;
  sections: Record<SectionName, string>;
  steps: KbStep[];
  escalateWhen: string[];
  placeholders: string[];
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function numberedItems(markdown: string): string[] {
  return [...markdown.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

function bulletItems(markdown: string): string[] {
  return [...markdown.matchAll(/^[-*]\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

export function parseArticle(source: string): ParsedArticle {
  const { data, content } = matter(source);
  const meta = frontmatterSchema.parse(data);
  const body = content.trim();

  const parts = body.split(/^##\s+/m);
  const intro = parts.shift()!.trim();
  const found: string[] = [];
  const sections = {} as Record<SectionName, string>;
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    found.push(heading);
    sections[heading as SectionName] = newline === -1 ? "" : part.slice(newline + 1).trim();
  }
  if (found.join("|") !== SECTION_ORDER.join("|")) {
    throw new Error(`sections must be exactly ${SECTION_ORDER.join(" → ")}; found ${found.join(" → ")}`);
  }

  const steps: KbStep[] = [
    ...numberedItems(sections["Quick fixes"]).map((text, i) => ({ section: "quick" as const, order: i + 1, text })),
    ...numberedItems(sections["Advanced steps"]).map((text, i) => ({ section: "advanced" as const, order: i + 1, text })),
  ];

  return {
    meta,
    body,
    intro,
    sections,
    steps,
    escalateWhen: bulletItems(sections["Escalate when"]),
    placeholders: [...new Set([...source.matchAll(PLACEHOLDER)].map((m) => m[1]!))],
  };
}

export const unknownPlaceholders = (a: ParsedArticle) => a.placeholders.filter((p) => !(p in kbPlaceholders));
