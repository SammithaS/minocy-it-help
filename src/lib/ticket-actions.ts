/**
 * Ticket state changes shared by the console, the portal, signed email links and inbound email.
 * Each updates D1, records a ticket event, pushes to the live board and tells the workflow.
 */
import * as msg from "../email/messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { sendTicketEvent, WORKFLOW_EVENTS } from "../workflows/ticket-workflow";
import { loadTicketContext } from "./ticket-context";
import { notifyBoard, startTicketWorkflow, type TicketRow } from "./tickets";

type Row = Pick<TicketRow, "id" | "number" | "team_id" | "status" | "assignee_id" | "first_response_at" | "workflow_instance_id" | "requester_id">;

export async function getTicketByNumber(env: AppEnv, number: string): Promise<Row | null> {
  return env.DB.prepare(
    "SELECT id, number, team_id, status, assignee_id, first_response_at, workflow_instance_id, requester_id FROM tickets WHERE number = ?",
  )
    .bind(number)
    .first<Row>();
}

const event = (env: AppEnv, ticketId: string, actorId: string | null, type: string, data: Record<string, unknown>) =>
  env.DB.prepare("INSERT INTO ticket_events (id, ticket_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
    crypto.randomUUID(),
    ticketId,
    actorId,
    type,
    JSON.stringify(data),
    Date.now(),
  );

/** First public staff action stops the SLA "first response" clock. */
export async function markFirstResponse(env: AppEnv, t: Row) {
  if (t.first_response_at) return;
  const now = Date.now();
  await env.DB.prepare("UPDATE tickets SET first_response_at = ? WHERE id = ? AND first_response_at IS NULL").bind(now, t.id).run();
  await sendTicketEvent(env, t.workflow_instance_id, WORKFLOW_EVENTS.firstResponse, { at: now });
}

export async function assignTicket(env: AppEnv, t: Row, assigneeId: string, actorId: string) {
  const now = Date.now();
  const status = t.status === "NEW" ? "ASSIGNED" : t.status;
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET assignee_id = ?, status = ?, updated_at = ? WHERE id = ?").bind(assigneeId, status, now, t.id),
    event(env, t.id, actorId, "assigned", { assigneeId }),
  ]);
  await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { assigneeId, status } });
}

export async function setTicketStatus(env: AppEnv, t: Row, status: "IN_PROGRESS" | "WAITING_ON_USER", actorId: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET status = ?, assignee_id = COALESCE(assignee_id, ?), updated_at = ? WHERE id = ?").bind(status, actorId, now, t.id),
    event(env, t.id, actorId, "status_changed", { from: t.status, to: status }),
  ]);
  if (status === "IN_PROGRESS") await markFirstResponse(env, t);
  await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status } });
}

export async function resolveTicket(env: AppEnv, t: Row, note: string, actorId: string) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET status = 'RESOLVED', resolved_at = ?, assignee_id = COALESCE(assignee_id, ?), updated_at = ? WHERE id = ?").bind(now, actorId, now, t.id),
    env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'public', 'console', ?)").bind(
      crypto.randomUUID(),
      t.id,
      actorId,
      `Resolved: ${note}`,
      now,
    ),
    event(env, t.id, actorId, "resolved", { note }),
  ]);
  await markFirstResponse(env, t);
  await sendTicketEvent(env, t.workflow_instance_id, WORKFLOW_EVENTS.resolved, { note, byUserId: actorId });
  await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status: "RESOLVED" } });
}

/**
 * The requester answers "Did this fix it?". With a running workflow, the workflow closes or reopens
 * (and emails); without one (e.g. it already finished), we apply the change directly.
 */
export async function confirmResolution(env: AppEnv, t: Row, answer: "yes" | "no", reason?: string): Promise<"closed" | "reopened" | "ignored"> {
  if (t.status !== "RESOLVED") return "ignored";
  await env.DB.batch([
    event(env, t.id, t.requester_id, "confirmation", { answer, reason: reason ?? null }),
    ...(reason
      ? [
          env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'public', 'portal', ?)").bind(
            crypto.randomUUID(),
            t.id,
            t.requester_id,
            `Still not fixed: ${reason}`,
            Date.now(),
          ),
        ]
      : []),
  ]);
  const delivered = await sendTicketEvent(env, t.workflow_instance_id, WORKFLOW_EVENTS.userConfirmed, { answer, reason });
  const now = Date.now();
  if (delivered) {
    // Apply the status now so the UI is consistent; the workflow sends the emails and its own
    // close/reopen updates are conditional on status, so they become no-ops.
    const status = answer === "yes" ? "CLOSED" : t.assignee_id ? "ASSIGNED" : "NEW";
    await env.DB.prepare(
      answer === "yes"
        ? "UPDATE tickets SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'RESOLVED'"
        : `UPDATE tickets SET status = '${status}', resolved_at = NULL, updated_at = ? WHERE id = ? AND status = 'RESOLVED'`,
    )
      .bind(...(answer === "yes" ? [now, now, t.id] : [now, t.id]))
      .run();
    await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status } });
    return answer === "yes" ? "closed" : "reopened";
  }

  if (answer === "yes") {
    await env.DB.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ?").bind(now, now, t.id).run();
    await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status: "CLOSED" } });
    return "closed";
  }
  await reopenClosedOrStale(env, t, reason ?? "");
  return "reopened";
}

/** Reopen without a live workflow (closed tickets): new workflow instance + notify the team. */
export async function reopenClosedOrStale(env: AppEnv, t: Row, reason: string) {
  const now = Date.now();
  const status = t.assignee_id ? "ASSIGNED" : "NEW";
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET status = ?, resolved_at = NULL, closed_at = NULL, updated_at = ? WHERE id = ?").bind(status, now, t.id),
    event(env, t.id, t.requester_id, "reopened", { from: t.status, to: status, reason }),
  ]);
  const c = await loadTicketContext(env, t.id);
  if (c) await sendEmail(env, msg.reopenedNotice(env, c, reason)).catch((e) => console.error("[reopen] email failed", e));
  await startTicketWorkflow(env, t.id, { reopened: true });
  await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status } });
}
