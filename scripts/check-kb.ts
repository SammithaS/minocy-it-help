/**
 * Validates every kb/*.md article: frontmatter, section order, steps, placeholders, unique ids.
 * Usage: pnpm kb:check
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArticle, unknownPlaceholders, type ParsedArticle } from "./lib/kb-parse";

const dir = "kb";
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const errors: string[] = [];
const seen = new Map<string, string>();
const articles: ParsedArticle[] = [];

for (const file of files) {
  const fail = (msg: string) => errors.push(`${file}: ${msg}`);
  let a: ParsedArticle;
  try {
    a = parseArticle(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    continue;
  }
  articles.push(a);
  const { id } = a.meta;
  if (!file.startsWith(`${id}-`)) fail(`file name should start with "${id}-"`);
  if (seen.has(id)) fail(`duplicate id ${id} (also in ${seen.get(id)})`);
  seen.set(id, file);
  if (!a.intro.startsWith(`# ${a.meta.title}`)) fail("body must start with '# <title>' matching frontmatter");
  if (a.steps.filter((s) => s.section === "quick").length < 2) fail("needs at least 2 numbered quick fixes");
  if (a.escalateWhen.length < 2) fail("needs at least 2 'Escalate when' bullets");
  const unknown = unknownPlaceholders(a);
  if (unknown.length) fail(`unknown placeholders: ${unknown.join(", ")} (add them to kbPlaceholders in src/org-config.ts)`);
  // Safety: steps must never ask the user to share secrets.
  for (const s of a.steps) {
    if (/\b(send|share|tell|give)\b[^.]*\b(password|mfa code|recovery key)\b/i.test(s.text) && !/\b(never|don't|do not)\b/i.test(s.text)) {
      fail(`step ${s.section}#${s.order} looks like it asks the user to share a secret`);
    }
  }
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in ${files.length} articles:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}

const steps = articles.reduce((n, a) => n + a.steps.length, 0);
const byTeam = Object.entries(
  articles.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.meta.ticket_category]: (acc[a.meta.ticket_category] ?? 0) + 1 }), {}),
)
  .map(([k, v]) => `${k} ${v}`)
  .join(", ");
console.log(`✓ ${articles.length} articles, ${steps} steps — ${byTeam}`);
