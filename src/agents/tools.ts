import { tool } from "ai";
import { z } from "zod";
import { searchKb, type Os } from "../rag/search";
import type { AppEnv } from "../env";
import { STEP_TOOL, type GuideStep, type Priority, type SupportState } from "./state";

export interface ToolContext {
  env: AppEnv;
  os: Os | null;
  getState: () => SupportState;
  setState: (s: SupportState) => void;
}

interface ArticleRow {
  id: string;
  title: string;
  priority: Priority;
  ticket_category: string;
  action: string;
}

export function buildTools(ctx: ToolContext) {
  return {
    searchKnowledgeBase: tool({
      description:
        "Search the company IT guides for the user's problem. Use the user's own words plus any device details. Returns up to 5 guides with a confidence flag.",
      inputSchema: z.object({ query: z.string().min(2).max(300).describe("What's wrong, in plain words") }),
      execute: async ({ query }) => {
        const r = await searchKb({ db: ctx.env.DB, ai: ctx.env.AI, vectorize: ctx.env.VECTORIZE }, query, { os: ctx.os, limit: 5 });
        ctx.setState({ ...ctx.getState(), lastSearchConfident: r.confident });
        return {
          confident: r.confident,
          results: r.hits.map((h) => ({ articleId: h.articleId, title: h.title, matched: h.section, snippet: h.snippet })),
          guidance: r.confident
            ? "Pick the guide that fits the user's problem and call startGuide. If none fits, say so and offer to raise a ticket."
            : "No guide matches well. Tell the user you don't have a guide for this and offer to raise a ticket with the IT team. Don't improvise company-specific steps.",
        };
      },
    }),

    startGuide: tool({
      description: "Start walking the user through a guide (from searchKnowledgeBase). Loads its steps; then show step 1 with reportStepOutcome.",
      inputSchema: z.object({ articleId: z.string().regex(/^KB-\d{3}$/) }),
      execute: async ({ articleId }) => {
        const db = ctx.env.DB;
        const article = await db
          .prepare("SELECT id, title, priority, ticket_category, action FROM kb_articles WHERE id = ?")
          .bind(articleId)
          .first<ArticleRow>();
        if (!article) return { error: `No guide ${articleId}. Search again.` };
        const { results } = await db
          .prepare(`SELECT section, "order", text FROM kb_steps WHERE article_id = ? ORDER BY CASE section WHEN 'quick' THEN 0 ELSE 1 END, "order"`)
          .bind(articleId)
          .all<{ section: "quick" | "advanced"; order: number; text: string }>();
        const steps: GuideStep[] = results.map((r, i) => ({ order: i + 1, section: r.section, text: r.text, status: "pending" }));
        const body = await db.prepare("SELECT body FROM kb_articles WHERE id = ?").bind(articleId).first<{ body: string }>();
        const escalateWhen = (body?.body.split(/^## Escalate when\s*$/m)[1] ?? "")
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2));
        const prev = ctx.getState();
        ctx.setState({
          ...prev,
          articleId,
          articleTitle: article.title,
          articlePriority: article.priority,
          ticketCategory: article.ticket_category,
          steps,
          currentStep: 0,
          failedCount: 0,
          resolvedByAssistant: false,
          escalationReason: null,
        });
        return {
          articleId,
          title: article.title,
          totalSteps: steps.length,
          escalateWhen,
          guidance: `Now call ${STEP_TOOL} with stepNumber 1. Don't write the step text yourself.`,
        };
      },
    }),

    [STEP_TOOL]: tool({
      description:
        "Show ONE guide step to the user as a card with 'That fixed it' / 'Still not working' buttons, and wait for their answer. The card shows the step text from the guide.",
      inputSchema: z.object({ stepNumber: z.number().int().min(1).describe("1-based step number from the current guide") }),
      outputSchema: z.object({ outcome: z.enum(["worked", "failed"]), note: z.string().optional() }),
      // No execute: the browser answers with the user's button click (client tool).
    }),

    flagEscalation: tool({
      description:
        "Call when one of the current guide's 'Escalate when' conditions clearly applies (e.g. many people affected, hardware fault, data loss). Hands over to the IT team.",
      inputSchema: z.object({ condition: z.string().max(200), manyUsersAffected: z.boolean().default(false) }),
      execute: async ({ condition, manyUsersAffected }) => {
        const s = ctx.getState();
        const order: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
        let p: Priority = s.suggestedPriority ?? s.articlePriority ?? "MEDIUM";
        if (manyUsersAffected && order.indexOf(p) < order.indexOf("HIGH")) p = "HIGH";
        ctx.setState({ ...s, escalationReason: "escalate_condition", suggestedPriority: p });
        return { escalated: true, condition, priority: p, guidance: "Explain briefly why this needs the IT team and offer to raise a ticket." };
      },
    }),
  };
}

export type SupportTools = ReturnType<typeof buildTools>;
