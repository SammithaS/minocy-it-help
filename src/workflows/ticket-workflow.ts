/**
 * TicketWorkflow — the durable lifecycle of one ticket (instance id = ticket id). Orchestrates the
 * Triage agent and every email, and waits on events sent by the console, the portal and email:
 *
 *   triage (agent) → email team (+admin if CRITICAL) → email employee
 *   → wait "first-response" until 75 % of the SLA → reminder → wait until the SLA → escalate + breach
 *   → wait "resolved" → "Did this fix it?" → wait "user-confirmed" (3 days)
 *        yes / no answer → close            no → reopen, notify, wait for "resolved" again (max 3 rounds)
 *
 * Each step.do is retried by Workflows; email failures (live transport) throw so they retry.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getAgentByName, type Agent } from "agents";
import type { TriageAgent, TriageResult } from "../agents/triage-agent";
import * as msg from "../email/messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { loadTicketContext } from "../lib/ticket-context";
import { notifyBoard } from "../lib/tickets";

export interface TicketWorkflowParams {
  ticketId: string;
  /** A closed ticket was reopened: skip triage and the "new ticket" emails, go straight to resolution. */
  reopened?: boolean;
}

export const WORKFLOW_EVENTS = {
  firstResponse: "first-response",
  resolved: "resolved",
  userConfirmed: "user-confirmed",
} as const;

export interface ResolvedPayload {
  note: string;
  byUserId: string;
}
export interface ConfirmedPayload {
  answer: "yes" | "no";
  reason?: string;
}

const RETRY = { retries: { limit: 5, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };
const MAX_REOPEN_ROUNDS = 3;

export class TicketWorkflow extends WorkflowEntrypoint<AppEnv, TicketWorkflowParams> {
  async run(event: WorkflowEvent<TicketWorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const { ticketId } = event.payload;
    const confirmDays = Number(env.CONFIRM_TIMEOUT_DAYS ?? 3);

    // Timing is computed once in a step, so replays after a restart use the same numbers.
    const timing = await step.do("load", RETRY, async () => {
      const c = await loadTicketContext(env, ticketId);
      if (!c) throw new Error(`ticket ${ticketId} not found`);
      const created = c.ticket.created_at;
      const due = c.ticket.sla_due_at ?? created + 8 * 3_600_000;
      return { number: c.ticket.number, priority: c.ticket.priority, reminderAt: created + Math.round((due - created) * 0.75), dueAt: due };
    });

    if (event.payload.reopened) return this.resolutionLoop(step, ticketId, confirmDays);

    // 1. Triage agent (back-office). Never blocks the ticket: failures become "skipped".
    const triage = await step.do("triage", { retries: { limit: 2, delay: "15 seconds" }, timeout: "3 minutes" }, async (): Promise<TriageResult> => {
      try {
        const ns = env.TRIAGE_AGENT as unknown as DurableObjectNamespace<Agent<AppEnv>>;
        const agent = (await getAgentByName(ns, "triage")) as unknown as DurableObjectStub<TriageAgent>;
        return (await agent.triage(ticketId)) as TriageResult;
      } catch (e) {
        console.warn("[workflow] triage failed:", e instanceof Error ? e.message : e);
        return { status: "skipped", summary: "", duplicateOf: null, suggestedAssignee: null, suggestedPriority: null, likelyCause: null };
      }
    });

    // 2. Notify.
    await step.do("email-team", RETRY, async () => {
      const c = (await loadTicketContext(env, ticketId))!;
      return (await sendEmail(env, msg.teamNewTicket(env, c, triage.summary || null))).status;
    });
    if (timing.priority === "CRITICAL") {
      await step.do("email-admin-critical", RETRY, async () => {
        const c = (await loadTicketContext(env, ticketId))!;
        for (const to of c.adminEmails) await sendEmail(env, msg.adminCritical(env, c, to));
        return c.adminEmails.length;
      });
    }
    await step.do("email-employee", RETRY, async () => {
      const c = (await loadTicketContext(env, ticketId))!;
      return (await sendEmail(env, msg.employeeAck(env, c))).status;
    });

    // 3. First response within the SLA: reminder at 75 %, escalation at 100 %.
    const responded = await step.do("check-first-response", async () => {
      const r = await env.DB.prepare("SELECT first_response_at FROM tickets WHERE id = ?").bind(ticketId).first<{ first_response_at: number | null }>();
      return !!r?.first_response_at;
    });
    if (!responded) {
      const untilReminder = await step.do("time-to-reminder", async () => Math.max(1000, timing.reminderAt - Date.now()));
      const firstInTime = await this.waitOrTimeout(step, "first-response", WORKFLOW_EVENTS.firstResponse, untilReminder);
      if (!firstInTime) {
        await step.do("sla-reminder", RETRY, async () => {
          if (await this.hasFirstResponse(ticketId)) return "already responded";
          const c = (await loadTicketContext(env, ticketId))!;
          await this.event(ticketId, "sla_reminder", { at: Date.now() });
          return (await sendEmail(env, msg.slaReminder(env, c))).status;
        });
        const untilDue = await step.do("time-to-due", async () => Math.max(1000, timing.dueAt - Date.now()));
        const firstBeforeDue = await this.waitOrTimeout(step, "first-response-after-reminder", WORKFLOW_EVENTS.firstResponse, untilDue);
        if (!firstBeforeDue) {
          await step.do("sla-escalate", RETRY, async () => {
            if (await this.hasFirstResponse(ticketId)) return "already responded";
            await env.DB.prepare("UPDATE tickets SET sla_breached = 1, updated_at = ? WHERE id = ?").bind(Date.now(), ticketId).run();
            await this.event(ticketId, "escalated", { reason: "sla_breached" });
            const c = (await loadTicketContext(env, ticketId))!;
            for (const to of c.adminEmails) await sendEmail(env, msg.slaEscalation(env, c, to));
            await notifyBoard(env, { type: "ticket.updated", ticketId, number: c.ticket.number, teamId: c.ticket.team_id, changes: { slaBreached: true } });
            return c.adminEmails.length;
          });
        }
      }
    }

    return this.resolutionLoop(step, ticketId, confirmDays);
  }

  /** Resolution → "Did this fix it?" → close, or reopen and wait again. */
  private async resolutionLoop(step: WorkflowStep, ticketId: string, confirmDays: number) {
    const env = this.env;
    for (let round = 1; round <= MAX_REOPEN_ROUNDS; round++) {
      let resolved: ResolvedPayload;
      try {
        const ev = await step.waitForEvent<ResolvedPayload>(`resolved-${round}`, { type: WORKFLOW_EVENTS.resolved, timeout: "60 days" });
        resolved = ev.payload;
      } catch {
        return { outcome: "stale", round };
      }

      await step.do(`email-resolved-${round}`, RETRY, async () => {
        const c = (await loadTicketContext(env, ticketId))!;
        return (await sendEmail(env, await msg.resolvedConfirm(env, c, resolved.note, confirmDays))).status;
      });

      let answer: ConfirmedPayload = { answer: "yes" };
      try {
        const ev = await step.waitForEvent<ConfirmedPayload>(`user-confirmed-${round}`, { type: WORKFLOW_EVENTS.userConfirmed, timeout: `${confirmDays} days` });
        answer = ev.payload;
      } catch {
        // No answer in time → treat as fixed.
      }

      if (answer.answer === "yes") {
        await step.do(`close-${round}`, RETRY, async () => {
          const now = Date.now();
          await env.DB.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'RESOLVED'").bind(now, now, ticketId).run();
          await this.event(ticketId, "closed", { by: "workflow" });
          const c = (await loadTicketContext(env, ticketId))!;
          await notifyBoard(env, { type: "ticket.updated", ticketId, number: c.ticket.number, teamId: c.ticket.team_id, changes: { status: "CLOSED" } });
          return "closed";
        });
        return { outcome: "closed", round };
      }

      await step.do(`reopen-${round}`, RETRY, async () => {
        const c = (await loadTicketContext(env, ticketId))!;
        const now = Date.now();
        const status = c.ticket.assignee_id ? "ASSIGNED" : "NEW";
        await env.DB.prepare("UPDATE tickets SET status = ?, resolved_at = NULL, updated_at = ? WHERE id = ? AND status IN ('RESOLVED','CLOSED')").bind(status, now, ticketId).run();
        await this.event(ticketId, "reopened", { by: "requester", reason: answer.reason ?? null });
        await sendEmail(env, msg.reopenedNotice(env, c, answer.reason ?? ""));
        await notifyBoard(env, { type: "ticket.updated", ticketId, number: c.ticket.number, teamId: c.ticket.team_id, changes: { status } });
        return status;
      });
    }
    return { outcome: "max-reopens" };
  }

  /** waitForEvent that returns false on timeout instead of throwing. */
  private async waitOrTimeout(step: WorkflowStep, name: string, type: string, timeoutMs: number): Promise<boolean> {
    try {
      await step.waitForEvent(name, { type, timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private async hasFirstResponse(ticketId: string) {
    const r = await this.env.DB.prepare("SELECT first_response_at FROM tickets WHERE id = ?").bind(ticketId).first<{ first_response_at: number | null }>();
    return !!r?.first_response_at;
  }

  private async event(ticketId: string, type: string, data: Record<string, unknown>) {
    await this.env.DB.prepare("INSERT INTO ticket_events (id, ticket_id, actor_id, type, data, created_at) VALUES (?, ?, NULL, ?, ?, ?)")
      .bind(crypto.randomUUID(), ticketId, type, JSON.stringify(data), Date.now())
      .run();
  }
}

/** Sends an event to a ticket's workflow. Never throws (the instance may have finished). */
export async function sendTicketEvent(env: AppEnv, instanceId: string | null, type: string, payload: unknown): Promise<boolean> {
  if (!instanceId) return false;
  try {
    const instance = await env.TICKET_WORKFLOW.get(instanceId);
    await instance.sendEvent({ type, payload });
    return true;
  } catch (e) {
    console.warn(`[workflow] sendEvent ${type} to ${instanceId} failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}
