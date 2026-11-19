/**
 * Dependency-free parsing of a KB article body (the markdown after the frontmatter).
 * Used by the ingestion script and by the Worker when rendering articles.
 */

export const SECTION_ORDER = ["Symptoms", "Quick fixes", "Advanced steps", "Escalate when"] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export const SECTION_KEYS = {
  Symptoms: "symptoms",
  "Quick fixes": "quick",
  "Advanced steps": "advanced",
  "Escalate when": "escalate",
} as const satisfies Record<SectionName, string>;
export type SectionKey = (typeof SECTION_KEYS)[SectionName];

export interface KbStep {
  section: "quick" | "advanced";
  order: number;
  text: string;
}

export interface ArticleSections {
  title: string;
  /** Paragraphs between the title and the first section (summary, safety notes). */
  intro: string[];
  symptoms: string[];
  steps: KbStep[];
  escalateWhen: string[];
  /** Raw markdown of each section, keyed by SectionName. */
  raw: Record<SectionName, string>;
}

const numbered = (md: string) => [...md.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1]!.trim());
const bullets = (md: string) => [...md.matchAll(/^[-*]\s+(.+)$/gm)].map((m) => m[1]!.trim());
const paragraphs = (md: string) =>
  md
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

export function parseSections(body: string): ArticleSections {
  const parts = body.trim().split(/^##\s+/m);
  const head = parts.shift()!.trim();
  const titleMatch = head.match(/^#\s+(.+)$/m);
  if (!titleMatch) throw new Error("article body must start with '# <title>'");
  const intro = paragraphs(head.slice(head.indexOf(titleMatch[0]) + titleMatch[0].length));

  const found: string[] = [];
  const raw = {} as Record<SectionName, string>;
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    found.push(heading);
    raw[heading as SectionName] = nl === -1 ? "" : part.slice(nl + 1).trim();
  }
  if (found.join("|") !== SECTION_ORDER.join("|")) {
    throw new Error(`sections must be exactly ${SECTION_ORDER.join(" → ")}; found ${found.join(" → ") || "none"}`);
  }

  return {
    title: titleMatch[1]!.trim(),
    intro,
    symptoms: bullets(raw.Symptoms),
    steps: [
      ...numbered(raw["Quick fixes"]).map((text, i) => ({ section: "quick" as const, order: i + 1, text })),
      ...numbered(raw["Advanced steps"]).map((text, i) => ({ section: "advanced" as const, order: i + 1, text })),
    ],
    escalateWhen: bullets(raw["Escalate when"]),
    raw,
  };
}

export interface KbChunk {
  /** Stable id shared by Vectorize and the FTS table, e.g. `KB-002#quick`. */
  id: string;
  articleId: string;
  section: "overview" | SectionKey;
  text: string;
}

/**
 * Chunks by heading. Every chunk is prefixed with the article title so it embeds with context.
 * The overview chunk folds the title, tags, intro and symptoms together — it's what most
 * "my X is broken" questions match.
 */
export function chunkArticle(articleId: string, title: string, tags: string[], s: ArticleSections): KbChunk[] {
  const prefix = (label: string) => `${title} — ${label}`;
  return [
    {
      id: `${articleId}#overview`,
      articleId,
      section: "overview",
      text: [title, `Keywords: ${tags.join(", ")}`, ...s.intro, "Symptoms:", ...s.symptoms.map((x) => `- ${x}`)].join("\n"),
    },
    { id: `${articleId}#quick`, articleId, section: "quick", text: `${prefix("Quick fixes")}\n${s.raw["Quick fixes"]}` },
    { id: `${articleId}#advanced`, articleId, section: "advanced", text: `${prefix("Advanced steps")}\n${s.raw["Advanced steps"]}` },
    { id: `${articleId}#escalate`, articleId, section: "escalate", text: `${prefix("Escalate when")}\n${s.raw["Escalate when"]}` },
  ];
}
