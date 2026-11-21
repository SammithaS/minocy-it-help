/**
 * Knowledge-gap agent — a back-office agent TicketWorkflow runs when a ticket is resolved.
 *
 * Reads the ticket, what was tried, how IT fixed it and the guide that was followed, and decides
 * whether the KB should change: add a step / escalate condition to that guide, or write a new guide
 * for a problem with none. It only ever writes a *proposal* (kb_proposals) — an admin reviews the diff
 * and approves it in the console, which re-indexes the article. Rules first (no model call when
 * there's nothing to learn), a daily budget, and an invalid draft is dropped, not stored.
 */
import { Agent } from "agents";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { AppEnv } from "../env";
import { nextArticleId, validateArticle, type ArticleMeta } from "../lib/kb-index";
import { chatModel } from "../lib/llm";
import { loadTicketContext } from "../lib/ticket-context";
import { SECTION_ORDER } from "../rag/kb-sections";

const DEFAULT_DAILY_BUDGET = 50;
/** A resolution note shorter than this rarely teaches anything ("done", "fixed"). */
const MIN_NOTE_CHARS = 25;

export interface KbGapResult {
  status: "proposed" | "none" | "skipped";
  reason: string;
  proposalId: string | null;
}

export class KbGapAgent extends Agent<AppEnv> {
  /** Called by TicketWorkflow (DO RPC). Idempotent per ticket. */
  async review(ticketId: string, resolutionNote: string): Promise<KbGapResult> {
    const env = this.env;
    const started = Date.now();
    const done = async (r: KbGapResult) => {
      await env.DB.prepare(
        `INSERT INTO agent_runs (id, ticket_id, agent, route_method, reason, status, summary, duration_ms, created_at)
         VALUES (?, ?, 'kb_gap', 'workflow', ?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), ticketId, r.reason.slice(0, 200), r.status === "skipped" ? "skipped" : "completed", r.status, Date.now() - started, Date.now())
        .run();
      return r;
    };

    const already = await env.DB.prepare("SELECT id FROM kb_proposals WHERE ticket_id = ? LIMIT 1").bind(ticketId).first<{ id: string }>();
    if (already) return { status: "proposed", reason: "already reviewed", proposalId: already.id };
    const reviewed = await env.DB.prepare("SELECT 1 AS ok FROM agent_runs WHERE agent = 'kb_gap' AND ticket_id = ? LIMIT 1").bind(ticketId).first();
    if (reviewed) return { status: "none", reason: "already reviewed", proposalId: null };

    if (resolutionNote.trim().length < MIN_NOTE_CHARS) return done({ status: "skipped", reason: "resolution note too short to learn from", proposalId: null });
    const budget = Number(env.KB_GAP_DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);
    const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE agent = 'kb_gap' AND status = 'completed' AND created_at > ?")
      .bind(Date.now() - 86_400_000)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= budget) return done({ status: "skipped", reason: "daily agent budget reached", proposalId: null });

    const c = await loadTicketContext(env, ticketId);
    if (!c) return done({ status: "skipped", reason: "ticket not found", proposalId: null });
    const t = c.ticket;
    const article = t.kb_article_id
      ? await env.DB.prepare("SELECT id, title, category, tags, os, ticket_category, priority, action, body FROM kb_articles WHERE id = ?")
          .bind(t.kb_article_id)
          .first<{ id: string; title: string; category: string; tags: string; os: string; ticket_category: string; priority: string; action: string; body: string }>()
      : null;
    if (article) {
      const pending = await env.DB.prepare("SELECT 1 AS ok FROM kb_proposals WHERE article_id = ? AND status = 'pending'").bind(article.id).first();
      if (pending) return done({ status: "skipped", reason: `a proposal for ${article.id} is already waiting for review`, proposalId: null });
    }
    const { results: comments } = await env.DB.prepare(
      "SELECT body, visibility FROM ticket_comments WHERE ticket_id = ? AND source != 'system' ORDER BY created_at LIMIT 20",
    )
      .bind(ticketId)
      .all<{ body: string; visibility: string }>();

    let o: GapDraft;
    try {
      o = await this.draft({
        ticket: `Ticket ${t.number} (${t.category}, ${t.priority}): ${t.title}`,
        context: [
          t.description,
          c.stepsTried.length ? `Already tried with the assistant: ${c.stepsTried.map((s) => `${s.text} (${s.result})`).join("; ")}` : "",
          comments.length ? `Conversation:\n${comments.map((x) => `- [${x.visibility}] ${x.body}`).join("\n")}` : "",
          `How IT resolved it: ${resolutionNote}`,
          article ? `Guide followed (${article.id}):\n${article.body}` : "No guide was followed.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        ticketNumber: t.number,
      });
    } catch (e) {
      return done({ status: "skipped", reason: `model unavailable: ${e instanceof Error ? e.message : e}`.slice(0, 200), proposalId: null });
    }

    if (o.action === "none" || !o.body) return done({ status: "none", reason: o.rationale || "nothing to add", proposalId: null });
    if (o.action === "update" && !article) o.action = "new";

    const meta: ArticleMeta =
      o.action === "update" && article
        ? {
            id: article.id,
            title: article.title,
            category: article.category,
            tags: JSON.parse(article.tags) as string[],
            os: JSON.parse(article.os) as ArticleMeta["os"],
            ticket_category: article.ticket_category as ArticleMeta["ticket_category"],
            priority: article.priority as ArticleMeta["priority"],
            action: article.action as ArticleMeta["action"],
          }
        : {
            id: await nextArticleId(env.DB),
            title: (o.title ?? t.title).trim(),
            category: t.category.charAt(0).toUpperCase() + t.category.slice(1),
            tags: (o.tags ?? []).slice(0, 10),
            os: ["windows", "macos"],
            ticket_category: t.category as ArticleMeta["ticket_category"],
            priority: t.priority === "CRITICAL" ? "HIGH" : t.priority,
            action: "troubleshoot",
          };
    // An update keeps the guide's own title, whatever heading the model wrote.
    const body = o.action === "update" ? o.body.replace(/^#\s+.+$/m, `# ${meta.title}`) : o.body;
    if (article && body.trim() === article.body.trim()) return done({ status: "none", reason: "no change to the guide", proposalId: null });
    const valid = validateArticle({ ...meta, body });
    if (!valid.ok) return done({ status: "skipped", reason: `draft didn't validate: ${valid.error}`, proposalId: null });

    const proposalId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO kb_proposals (id, ticket_id, article_id, kind, title, rationale, body, meta, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(proposalId, ticketId, meta.id, o.action, meta.title, o.rationale, body, JSON.stringify(meta), Date.now())
      .run();
    return done({ status: "proposed", reason: `${o.action} ${meta.id}: ${o.rationale}`, proposalId });
  }

  /** The one model call: what (if anything) should change in the KB. Separate so tests can stub it. */
  protected async draft(i: { ticket: string; context: string; ticketNumber: string }): Promise<GapDraft> {
    const { output } = await generateText({
      model: chatModel(this.env, { agent: "kb_gap", ticket: i.ticketNumber }),
      temperature: 0.2,
      output: Output.object({
        schema: z.object({
          action: z.enum(["none", "update", "new"]),
          rationale: z.string().max(400).describe("One or two sentences for the KB admin: what's missing and why it would help"),
          title: z.string().max(100).nullable().describe("For a new guide: a symptom-style title"),
          body: z.string().max(8000).nullable().describe("The FULL markdown body of the updated or new guide"),
          tags: z.array(z.string()).max(12).nullable().describe("For a new guide: 3–10 search keywords, incl. how employees say it"),
        }),
      }),
      system: [
        "You maintain an IT self-help knowledge base for employees. A ticket was just resolved by the IT team.",
        "Decide if the KB should change so the next employee can fix this themselves:",
        "- update: the guide that was followed is missing the step that fixed it (or an escalate condition). Return the full guide with the change; keep everything else word for word.",
        "- new: no guide covered this and employees could fix it themselves next time.",
        "- none: the fix needed IT (admin rights, hardware swap, a one-off outage), or the guide already covers it.",
        `Guide format: '# <Title>', an optional one-line intro, then exactly these sections in order: ${SECTION_ORDER.map((s) => `'## ${s}'`).join(", ")}.`,
        "Symptoms and Escalate when are '- ' bullets; Quick fixes and Advanced steps are numbered '1. ' steps, one action each, plain words, no admin-only actions.",
        "Keep {{placeholders}} as they are. Never include passwords, personal data or ticket numbers.",
      ].join("\n"),
      prompt: `${i.ticket}\n\n${i.context}`,
    });
    return output;
  }
}

export interface GapDraft {
  action: "none" | "update" | "new";
  rationale: string;
  title: string | null;
  body: string | null;
  tags: string[] | null;
}
