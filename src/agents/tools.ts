import { tool } from "ai";
import { z } from "zod";
import type { AppEnv } from "../env";
import { listAccessRequests, submitAccessRequest } from "../lib/access";
import { completePasswordReset } from "../lib/password-reset";
import { createTicket, notifyBoard } from "../lib/tickets";
import { STEP_TOOL, VERIFY_TOOL, type Priority, type SupportState } from "./state";

export interface ToolContext {
  env: AppEnv;
  sessionId: string;
  ownerId: string | null;
  getState: () => SupportState;
  setState: (s: SupportState) => void;
  /** Hand-offs to specialist agents (logged and shown as chips). */
  askKnowledgeAgent: (query: string) => Promise<{ articleId: string | null; title: string | null; clarifyingQuestion: string | null; reason: string }>;
  askTicketAgent: () => Promise<{ ok: boolean; error?: string }>;
  /** Model-chosen hand-off to the Access agent; returns what to do next. */
  askAccessAgent: (request: string) => Promise<{ guidance: string }>;
}

const ACCESS_STATUS_LABEL: Record<string, string> = {
  PENDING: "waiting for approval",
  APPROVED: "approved — being set up",
  PROVISIONED: "done — access granted",
  REJECTED: "not approved",
  EXPIRED: "expired (no answer in time)",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "new — waiting for the IT team",
  ASSIGNED: "assigned to an engineer",
  IN_PROGRESS: "being worked on",
  WAITING_ON_USER: "waiting for your reply",
  RESOLVED: "resolved — waiting for your confirmation",
  CLOSED: "closed",
};

export function buildTools(ctx: ToolContext) {
  const db = ctx.env.DB;

  const ownTicket = (number: string) =>
    db
      .prepare(
        `SELECT t.id, t.number, t.title, t.status, t.priority, t.sla_due_at, t.updated_at, t.team_id, tm.name AS team
         FROM tickets t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.number = ? AND t.requester_id = ?`,
      )
      .bind(number.toUpperCase().replace(/^INC(\d)/, "INC-$1"), ctx.ownerId)
      .first<{ id: string; number: string; title: string; status: string; priority: string; sla_due_at: number | null; updated_at: number; team_id: string | null; team: string | null }>();

  return {
    [STEP_TOOL]: tool({
      description:
        "Show ONE guide step to the user as a card with 'That fixed it' / 'Still not working' buttons, and wait for their answer. The card shows the step text from the guide.",
      inputSchema: z.object({ stepNumber: z.number().int().min(1).describe("1-based step number from the current guide") }),
      outputSchema: z.object({ outcome: z.enum(["worked", "failed", "skipped"]), note: z.string().optional() }),
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

    // ── hand-offs the supervisor model can choose when the routing rules didn't decide ──
    askKnowledgeAgent: tool({
      description: "Hand the problem to the Knowledge agent, which finds the right IT guide. Use for anything that sounds like a fixable IT problem.",
      inputSchema: z.object({ query: z.string().min(2).max(500).describe("The problem in the user's words plus any detail they gave") }),
      execute: async ({ query }) => {
        const r = await ctx.askKnowledgeAgent(query);
        if (r.articleId) return { guide: `${r.articleId} ${r.title}`, guidance: `Now call ${STEP_TOOL} with stepNumber 1. Don't write the step text yourself.` };
        if (r.clarifyingQuestion) return { guide: null, guidance: `Ask the user exactly one question: ${r.clarifyingQuestion}` };
        return { guide: null, guidance: "There's no guide for this. Say so briefly and offer to raise a ticket with the IT team." };
      },
    }),

    askTicketAgent: tool({
      description:
        "Hand over to the Ticket agent to draft a ticket for the IT team. Use only when the user wants a ticket or a person, or there's no self-help guide and they agree.",
      inputSchema: z.object({}),
      execute: async () => {
        const r = await ctx.askTicketAgent();
        return r.ok ? { drafted: true, guidance: "Now call createTicket so the user can review and approve the draft." } : { drafted: false, error: r.error };
      },
    }),

    createTicket: tool({
      description:
        "Raise the drafted ticket. The user sees an editable draft card and must approve it first — call this, don't ask in text.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        const s = ctx.getState();
        if (s.ticketNumber) return { number: s.ticketNumber, alreadyRaised: true };
        if (!s.ticketDraft || !ctx.ownerId) return { error: "No ticket draft. Ask the Ticket agent first." };
        const d = s.ticketDraft;
        const created = await createTicket(ctx.env, {
          requesterId: ctx.ownerId,
          title: d.title,
          description: d.summary,
          category: d.category as never,
          priority: d.priority,
          source: "CHAT",
          escalationReason: s.escalationReason,
          sessionId: ctx.sessionId,
          kbArticleId: d.kbArticleId,
          stepsTried: d.stepsTried,
          device: d.device,
        });
        ctx.setState({ ...ctx.getState(), ticketNumber: created.number });
        return {
          number: created.number,
          team: created.team?.name ?? "IT service desk",
          priority: created.priority,
          slaDueAt: new Date(created.slaDueAt).toISOString(),
        };
      },
    }),

    // ── access requests (Access agent → approval card → AccessRequestWorkflow) ──
    askAccessAgent: tool({
      description: "Hand over to the Access agent when the user wants access, a licence or permissions for an app or shared drive.",
      inputSchema: z.object({ request: z.string().min(2).max(500).describe("What they asked for, in their words") }),
      execute: async ({ request }) => ctx.askAccessAgent(request),
    }),

    submitAccessRequest: tool({
      description:
        "Send the access request the Access agent prepared. The user sees an approval card (app, approver, their reason) and must approve it — call this, don't ask in text.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        const s = ctx.getState();
        if (!s.accessDraft || !ctx.ownerId) return { error: "No access request prepared. Ask the Access agent first." };
        const r = await submitAccessRequest(ctx.env, {
          requesterId: ctx.ownerId,
          applicationId: s.accessDraft.applicationId,
          justification: s.accessDraft.justification,
          sessionId: ctx.sessionId,
        });
        if (!r.ok) return { error: r.error };
        ctx.setState({ ...ctx.getState(), accessRequestNumber: r.number, accessDraft: null, awaitingAccessApp: false });
        return { number: r.number, application: r.application, approver: r.approver?.name ?? null, status: r.status, existing: r.existing ?? false };
      },
    }),

    getMyAccessRequests: tool({
      description: "List the user's access requests (REQ-…) and their status.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = ctx.ownerId ? await listAccessRequests(ctx.env, ctx.ownerId, 10) : [];
        return {
          requests: rows.map((r) => ({ number: r.number, app: r.application, status: ACCESS_STATUS_LABEL[r.status] ?? r.status, approver: r.approver_name ?? r.approver_email, note: r.decision_note })),
        };
      },
    }),

    // ── self-service password reset (deterministic; no specialist model call) ──
    [VERIFY_TOOL]: tool({
      description: "Show the card where the user types the 6-digit code we emailed them. Wait for it. Never ask for the code in chat.",
      inputSchema: z.object({}),
      outputSchema: z.object({ verified: z.boolean() }),
      // No execute: the browser card verifies through the agent's checkResetCode() and answers { verified }.
    }),

    resetPassword: tool({
      description:
        "Unlock the account and email a one-time link to set a new password. The user approves in a card first — call this, don't ask in text.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        const s = ctx.getState();
        if (!s.passwordReset || s.passwordReset.stage === "code_sent" || !ctx.ownerId) return { done: false, error: "Identity not verified." };
        const r = await completePasswordReset(ctx.env, { resetId: s.passwordReset.id, userId: ctx.ownerId });
        if (!r.ok) return { done: false, error: r.reason === "expired" ? "The verification timed out. Start again." : "Couldn't reset the password." };
        ctx.setState({ ...ctx.getState(), passwordReset: { ...s.passwordReset, stage: "done" } });
        return { done: true, emailedTo: r.maskedEmail, unlocked: r.unlocked };
      },
    }),

    // ── tickets the user already has ──
    getMyTickets: tool({
      description: "List the user's recent tickets with their status.",
      inputSchema: z.object({ openOnly: z.boolean().default(true) }),
      execute: async ({ openOnly }) => {
        const { results } = await db
          .prepare(
            `SELECT number, title, status, priority, updated_at FROM tickets WHERE requester_id = ?
             ${openOnly ? "AND status NOT IN ('CLOSED')" : ""} ORDER BY created_at DESC LIMIT 10`,
          )
          .bind(ctx.ownerId)
          .all<{ number: string; title: string; status: string; priority: string; updated_at: number }>();
        return { tickets: results.map((t) => ({ ...t, status: STATUS_LABEL[t.status] ?? t.status })) };
      },
    }),

    getTicketStatus: tool({
      description: "Get the status of one of the user's tickets by number (e.g. INC-1031).",
      inputSchema: z.object({ number: z.string().regex(/^INC-?\d+$/i) }),
      execute: async ({ number }) => {
        const t = await ownTicket(number);
        if (!t) return { error: `No ticket ${number} found for you.` };
        const last = await db
          .prepare("SELECT body, created_at FROM ticket_comments WHERE ticket_id = ? AND visibility = 'public' ORDER BY created_at DESC LIMIT 1")
          .bind(t.id)
          .first<{ body: string; created_at: number }>();
        return {
          number: t.number,
          title: t.title,
          status: STATUS_LABEL[t.status] ?? t.status,
          team: t.team,
          priority: t.priority,
          dueBy: t.sla_due_at ? new Date(t.sla_due_at).toISOString() : null,
          latestUpdate: last?.body ?? null,
        };
      },
    }),

    addCommentToTicket: tool({
      description: "Add the user's message as a comment on one of their tickets (e.g. new details for the IT team).",
      inputSchema: z.object({ number: z.string().regex(/^INC-?\d+$/i), comment: z.string().min(2).max(2000) }),
      execute: async ({ number, comment }) => {
        const t = await ownTicket(number);
        if (!t) return { error: `No ticket ${number} found for you.` };
        const now = Date.now();
        await db.batch([
          db
            .prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'public', 'chat', ?)")
            .bind(crypto.randomUUID(), t.id, ctx.ownerId, comment, now),
          db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(now, t.id),
        ]);
        await notifyBoard(ctx.env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { comment: true } });
        return { added: true, number: t.number };
      },
    }),
  };
}

export type SupportTools = ReturnType<typeof buildTools>;
export type ToolName = keyof SupportTools;
