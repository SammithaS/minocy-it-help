import { generateText, Output } from "ai";
import { z } from "zod";
import { chatModel } from "../../lib/llm";
import { searchKb } from "../../rag/search";
import { SpecialistAgent } from "./base";

const input = z.object({
  query: z.string().min(1).max(1000),
  os: z.enum(["windows", "macos", "linux"]).nullable(),
  device: z.string().nullable(),
});
const output = z.object({
  articleId: z.string().nullable(),
  title: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  reason: z.string(),
  /** Set when the message is too vague to pick a guide. */
  clarifyingQuestion: z.string().nullable(),
  candidates: z.array(z.object({ articleId: z.string(), title: z.string() })),
  method: z.enum(["shortcut", "llm", "none"]),
});
export type KnowledgeInput = z.infer<typeof input>;
export type KnowledgeOutput = z.infer<typeof output>;

/** Clear winner thresholds for skipping the model call (tuned against evals/retrieval.yaml). */
const SHORTCUT_MIN_SCORE = 0.72;
const SHORTCUT_MIN_MARGIN = 0.12;

/**
 * Finds the right IT guide for a problem description. Hybrid search first; when one guide is a clear
 * winner it answers without a model call (free-tier friendly), otherwise the model reads the top
 * candidates and picks one — or none, or asks one clarifying question.
 */
export class KnowledgeAgent extends SpecialistAgent<KnowledgeInput, KnowledgeOutput> {
  readonly displayName = "Knowledge agent";
  readonly inputSchema = input;
  readonly outputSchema = output;

  protected async run({ query, os, device }: KnowledgeInput): Promise<KnowledgeOutput> {
    const r = await searchKb({ db: this.env.DB, ai: this.env.AI, vectorize: this.env.VECTORIZE }, query, { os, limit: 5 });
    const candidates = r.hits.map((h) => ({ articleId: h.articleId, title: h.title }));
    if (!r.confident || r.hits.length === 0) {
      return { articleId: null, title: null, confidence: "none", reason: "No guide matches this well.", clarifyingQuestion: null, candidates, method: "none" };
    }

    const [top, second] = r.hits;
    const margin = (top!.vectorScore ?? 0) - (second?.vectorScore ?? 0);
    if ((top!.vectorScore ?? 0) >= SHORTCUT_MIN_SCORE && margin >= SHORTCUT_MIN_MARGIN && top!.keywordMatch) {
      return {
        articleId: top!.articleId,
        title: top!.title,
        confidence: "high",
        reason: `Clear match (similarity ${top!.vectorScore?.toFixed(2)}, keyword match).`,
        clarifyingQuestion: null,
        candidates,
        method: "shortcut",
      };
    }

    const { output: pick } = await generateText({
      model: chatModel(this.env, { agent: "knowledge" }),
      temperature: 0,
      output: Output.object({
        schema: z.object({
          articleId: z.string().nullable().describe("One of the candidate ids, or null if none fits"),
          confidence: z.enum(["high", "medium", "low"]),
          reason: z.string().max(200),
          clarifyingQuestion: z.string().max(200).nullable().describe("Only if the problem is too vague to choose"),
        }),
      }),
      system:
        "You pick the single IT guide that best fits an employee's problem. Choose only from the candidates. " +
        "If none genuinely fits, return null. Ask a clarifying question only if two candidates fit equally and one short question would decide.",
      prompt: [
        `Problem: ${query}`,
        device ? `Device: ${device}` : "",
        "Candidates:",
        ...r.hits.map((h, i) => `${i + 1}. ${h.articleId} — ${h.title}: ${h.snippet}`),
      ]
        .filter(Boolean)
        .join("\n"),
    });

    const chosen = r.hits.find((h) => h.articleId === pick.articleId);
    return {
      articleId: chosen?.articleId ?? null,
      title: chosen?.title ?? null,
      confidence: chosen ? pick.confidence : "none",
      reason: pick.reason,
      clarifyingQuestion: pick.clarifyingQuestion,
      candidates,
      method: "llm",
    };
  }

  protected summarize(o: KnowledgeOutput) {
    if (o.articleId) return `${o.articleId} ${o.title} (${o.confidence}, ${o.method})`;
    return o.clarifyingQuestion ? `needs clarification: ${o.clarifyingQuestion}` : "no matching guide";
  }
}
