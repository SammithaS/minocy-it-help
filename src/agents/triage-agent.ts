/**
 * Triage agent — a back-office agent run by TicketWorkflow on every new ticket.
 *
 * Finds likely duplicates (Vectorize, `tickets` namespace), suggests an assignee from the team
 * (least open work) and a priority, and names a likely cause. It writes an INTERNAL note and a
 * `triaged` event; it never assigns or changes the ticket itself — a human stays in charge.
 * Free-tier guard: a daily run budget; past it, triage is skipped (logged) instead of failing.
 */
import { Agent } from "agents";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { AppEnv } from "../env";
import { chatModel } from "../lib/llm";
import { loadTicketContext } from "../lib/ticket-context";
import { notifyBoard } from "../lib/tickets";
import { embedPassages } from "../rag/embed";

import { DUPLICATE_MIN_SCORE, TICKETS_NAMESPACE } from "./triage-config";

export { DUPLICATE_MIN_SCORE, TICKETS_NAMESPACE };
const DEFAULT_DAILY_BUDGET = 150;

export interface TriageResult {
  status: "completed" | "skipped" | "fallback";
  /** One line for the team email. */
  summary: string;
  duplicateOf: string | null;
  suggestedAssignee: { id: string; name: string } | null;
  suggestedPriority: string | null;
  likelyCause: string | null;
}

interface Candidate {
  id: string;
  number: string;
  title: string;
  status: string;
  score: number;
}

export class TriageAgent extends Agent<AppEnv> {
  /** Called by TicketWorkflow (DO RPC). Idempotent per ticket: re-running replaces nothing, adds no second note. */
  async triage(ticketId: string): Promise<TriageResult> {
    const env = this.env;
    const started = Date.now();
    const already = await env.DB.prepare("SELECT data FROM ticket_events WHERE ticket_id = ? AND type = 'triaged' LIMIT 1")
      .bind(ticketId)
      .first<{ data: string }>();
    if (already) return JSON.parse(already.data) as TriageResult;

    const budget = Number(env.TRIAGE_DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);
    const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE agent = 'triage' AND status != 'skipped' AND created_at > ?")
      .bind(Date.now() - 86_400_000)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= budget) {
      const r: TriageResult = { status: "skipped", summary: "Triage skipped (daily agent budget reached).", duplicateOf: null, suggestedAssignee: null, suggestedPriority: null, likelyCause: null };
      await this.record(ticketId, r, started, "daily budget reached");
      return r;
    }

    const c = await loadTicketContext(env, ticketId);
    if (!c) throw new Error(`Ticket ${ticketId} not found`);
    const t = c.ticket;

    // 1. Duplicates: embed this ticket, compare with recent ones in the same namespace.
    let candidates: Candidate[] = [];
    try {
      const [vec] = await embedPassages(env.AI, [`${t.title}\n${t.description}`]);
      const matches = await env.VECTORIZE.query(vec!, { topK: 6, namespace: TICKETS_NAMESPACE, returnMetadata: "none" });
      await env.VECTORIZE.upsert([{ id: t.id, values: vec!, namespace: TICKETS_NAMESPACE, metadata: { number: t.number, category: t.category } }]);
      const ids = matches.matches.filter((m) => m.id !== t.id && m.score >= DUPLICATE_MIN_SCORE);
      if (ids.length) {
        const rows = await env.DB.prepare(
          `SELECT id, number, title, status FROM tickets WHERE id IN (${ids.map(() => "?").join(",")}) AND created_at > ?`,
        )
          .bind(...ids.map((m) => m.id), Date.now() - 30 * 86_400_000)
          .all<Omit<Candidate, "score">>();
        candidates = rows.results.map((r) => ({ ...r, score: ids.find((m) => m.id === r.id)!.score }));
      }
    } catch (e) {
      console.warn("[triage] duplicate search unavailable:", e instanceof Error ? e.message : e);
    }

    // 2. Team members and their open load (least-loaded is the deterministic fallback).
    const { results: members } = await env.DB.prepare(
      `SELECT u.id, u.name, (SELECT COUNT(*) FROM tickets x WHERE x.assignee_id = u.id AND x.status NOT IN ('RESOLVED','CLOSED')) AS open
       FROM team_members m JOIN user u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY open, u.name`,
    )
      .bind(t.team_id ?? "")
      .all<{ id: string; name: string; open: number }>();
    const leastLoaded = members[0] ?? null;

    let result: TriageResult;
    try {
      const { output: o } = await generateText({
        model: chatModel(env, { agent: "triage", ticket: t.number }),
        temperature: 0,
        output: Output.object({
          schema: z.object({
            duplicateOf: z.string().nullable().describe("Ticket number this duplicates, from the candidates, or null"),
            likelyCause: z.string().max(200),
            suggestedAssigneeId: z.string().nullable().describe("One of the team member ids, or null"),
            suggestedPriority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
            priorityReason: z.string().max(150),
          }),
        }),
        system:
          "You triage IT tickets for the service desk. Be brief and concrete. Only mark a duplicate if it is clearly the same issue " +
          "(same symptom, likely same root cause), not just the same category. Prefer the least-loaded team member unless the ticket clearly needs someone else.",
        prompt: [
          `Ticket ${t.number} (${t.priority}, team ${c.team?.name ?? "none"}): ${t.title}`,
          t.description,
          c.stepsTried.length ? `Already tried: ${c.stepsTried.map((s) => `${s.text} (${s.result})`).join("; ")}` : "",
          t.device ? `Device: ${t.device}` : "",
          candidates.length ? `Possible duplicates:\n${candidates.map((d) => `- ${d.number} [${d.status}] ${d.title} (similarity ${d.score.toFixed(2)})`).join("\n")}` : "No similar recent tickets.",
          members.length ? `Team members (open tickets):\n${members.map((m) => `- ${m.id}: ${m.name} (${m.open})`).join("\n")}` : "No team members.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      const assignee = members.find((m) => m.id === o.suggestedAssigneeId) ?? leastLoaded;
      const dup = candidates.find((d) => d.number === o.duplicateOf)?.number ?? null;
      result = {
        status: "completed",
        summary: [
          dup ? `Possible duplicate of ${dup}.` : null,
          `Likely cause: ${o.likelyCause.replace(/[.\s]+$/, "")}.`,
          assignee ? `Suggested assignee: ${assignee.name}.` : null,
          o.suggestedPriority !== t.priority ? `Suggests ${o.suggestedPriority} priority (${o.priorityReason}).` : null,
        ]
          .filter(Boolean)
          .join(" "),
        duplicateOf: dup,
        suggestedAssignee: assignee ? { id: assignee.id, name: assignee.name } : null,
        suggestedPriority: o.suggestedPriority,
        likelyCause: o.likelyCause,
      };
    } catch (e) {
      console.warn("[triage] model unavailable, rules-only triage:", e instanceof Error ? e.message : e);
      result = {
        status: "fallback",
        summary: [
          candidates[0] ? `Similar recent ticket: ${candidates[0].number} (${candidates[0].title}).` : null,
          leastLoaded ? `Suggested assignee: ${leastLoaded.name} (fewest open tickets).` : null,
        ]
          .filter(Boolean)
          .join(" ") || "No duplicates found.",
        duplicateOf: null,
        suggestedAssignee: leastLoaded ? { id: leastLoaded.id, name: leastLoaded.name } : null,
        suggestedPriority: null,
        likelyCause: null,
      };
    }

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, NULL, ?, 'internal', 'system', ?)").bind(
        crypto.randomUUID(),
        t.id,
        `Triage agent: ${result.summary}`,
        now,
      ),
      env.DB.prepare("INSERT INTO ticket_events (id, ticket_id, actor_id, type, data, created_at) VALUES (?, ?, NULL, 'triaged', ?, ?)").bind(
        crypto.randomUUID(),
        t.id,
        JSON.stringify(result),
        now,
      ),
    ]);
    await this.record(t.id, result, started, null);
    await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { triaged: true } });
    return result;
  }

  private async record(ticketId: string, r: TriageResult, started: number, reason: string | null) {
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent, route_method, reason, status, summary, duration_ms, created_at)
       VALUES (?, ?, 'triage', 'workflow', ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), ticketId, reason ?? r.status, r.status === "skipped" ? "skipped" : "completed", r.summary.slice(0, 500), Date.now() - started, Date.now())
      .run();
  }
}
