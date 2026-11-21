/**
 * Runs promptfoo suites with telemetry off, then writes a summary to evals/RESULTS.md.
 *   pnpm eval                       # all suites
 *   pnpm eval routing escalation    # some suites
 *
 * Suites: retrieval (KB search), routing (supervisor), escalation (rules), ticket-quality (LLM judge),
 * triage (duplicate detection). Retrieval, routing, ticket-quality and triage call your Cloudflare
 * account (Workers AI / Vectorize) and Gemini key; escalation is deterministic.
 * Running a subset keeps the other suites' sections from the previous report.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SUITES = ["retrieval", "routing", "escalation", "ticket-quality", "triage"] as const;
type Suite = (typeof SUITES)[number];
const wanted = process.argv.slice(2);
const suites = wanted.length ? SUITES.filter((s) => wanted.includes(s)) : [...SUITES];

interface Component {
  pass: boolean;
  assertion?: { metric?: string };
}
interface Row {
  vars: Record<string, string>;
  success: boolean;
  response?: { output?: string };
  gradingResult?: { componentResults?: Component[] };
}

function parse(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 140);
const caseLabel = (v: Record<string, string>) => v.query ?? v.message ?? v.title ?? v.messages ?? JSON.stringify(v);
function got(suite: Suite, output: string | undefined): string {
  const o = parse(output);
  if (suite === "retrieval") return ((o.ids as string[] | undefined) ?? []).join(", ");
  if (suite === "routing") return `${o.agent} (${o.method}${o.tool ? `: ${o.tool}` : ""})`;
  if (suite === "escalation") return `${o.kind}${o.reason ? ` / ${o.reason}` : ""}`;
  if (suite === "triage") return `${o.duplicateOf ?? "none"} (top ${o.top} @ ${o.score})`;
  if (suite === "ticket-quality") return `${o.priority} ${o.category}: ${o.title}`;
  return output ?? "";
}
const pct = (m: { pass: number; total: number }) => `${((100 * m.pass) / m.total).toFixed(1)}% (${m.pass}/${m.total})`;

mkdirSync("evals/results", { recursive: true });
const sections = new Map<string, string>();
// Keep sections of suites not run this time.
if (existsSync("evals/RESULTS.md")) {
  for (const part of readFileSync("evals/RESULTS.md", "utf8").split(/^## /m).slice(1)) {
    const name = part.split("\n", 1)[0]!.trim();
    if (!suites.includes(name as Suite)) sections.set(name, `## ${part.trimEnd()}\n`);
  }
}
let failed = false;

for (const suite of suites) {
  const out = `evals/results/${suite}.json`;
  const res = spawnSync(
    "pnpm",
    ["exec", "promptfoo", "eval", "-c", `evals/${suite}.yaml`, "--no-cache", "--max-concurrency", "2", "--no-progress-bar", "--no-table", "-o", out],
    { stdio: "inherit", shell: true, env: { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1" } },
  );
  if (!existsSync(out) || res.error || res.status === null) {
    console.error(`✗ ${suite}: promptfoo didn't produce results (exit ${res.status ?? "?"})`);
    sections.set(suite, `## ${suite}\n\nDidn't run (promptfoo exited with ${res.status ?? "an error"}). See the terminal output.\n`);
    failed = true;
    continue;
  }
  const rows: Row[] = JSON.parse(readFileSync(out, "utf8")).results.results;
  const metrics = new Map<string, { pass: number; total: number }>();
  const misses: string[] = [];
  for (const r of rows) {
    for (const c of r.gradingResult?.componentResults ?? []) {
      const name = c.assertion?.metric;
      if (!name) continue;
      // Retrieval: no-guide only applies to out-of-scope rows, hit@k only to in-scope rows.
      const applies = suite !== "retrieval" ? true : name === "no-guide" ? r.vars.expected === "none" : r.vars.expected !== "none";
      if (!applies) continue;
      const m = metrics.get(name) ?? { pass: 0, total: 0 };
      m.total++;
      if (c.pass) m.pass++;
      metrics.set(name, m);
      if (!c.pass) misses.push(`| ${name} | ${cell(caseLabel(r.vars))} | ${cell(r.vars.expected ?? r.vars.category ?? "")} | ${cell(got(suite, r.response?.output))} |`);
    }
    if (!r.success) failed = true;
  }
  // Routing: how much the free rules decide, and accuracy on each path.
  if (suite === "routing") {
    for (const method of ["rules", "llm"] as const) {
      const rs = rows.filter((r) => parse(r.response?.output).method === method);
      const ok = rs.filter((r) => r.gradingResult?.componentResults?.some((c) => c.assertion?.metric === "routed" && c.pass)).length;
      if (rs.length) metrics.set(`routed ${method === "rules" ? "by rule" : "by model"} (${Math.round((100 * rs.length) / rows.length)}% of cases)`, { pass: ok, total: rs.length });
    }
  }
  const summary = [...metrics].map(([k, v]) => `| ${k} | ${pct(v)} |`).join("\n");
  console.log(`\n${suite}:\n${[...metrics].map(([k, v]) => `  ${k}: ${pct(v)}`).join("\n")}`);
  sections.set(
    suite,
    `## ${suite}\n\n| Metric | Score |\n|---|---|\n${summary}\n\n` +
      (misses.length ? `Misses:\n\n| Metric | Case | Expected | Got |\n|---|---|---|---|\n${misses.join("\n")}\n` : "No misses.\n"),
  );
}

const date = new Date().toISOString().slice(0, 16).replace("T", " ");
const ordered = [...SUITES.filter((s) => sections.has(s)).map((s) => sections.get(s)!), ...[...sections].filter(([k]) => !SUITES.includes(k as Suite)).map(([, v]) => v)];
writeFileSync("evals/RESULTS.md", `# Eval results\n\nGenerated by \`pnpm eval\` (last run ${date} UTC). Raw output: \`evals/results/*.json\` (git-ignored).\n\n${ordered.join("\n")}`);
console.log("\nWrote evals/RESULTS.md");
process.exit(failed ? 1 : 0);
