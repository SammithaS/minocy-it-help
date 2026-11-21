/**
 * Ticket creation and lookups shared by the chat agent, the REST API and (Phase 5) inbound email.
 */
import { z } from "zod";
import { PRIORITIES, SOURCES, type StepTried } from "../db/schema";
import type { AppEnv } from "../env";
import { TICKET_CATEGORIES } from "../org-config";
import { computeSlaDue } from "./sla";

export const newTicketSchema = z.object({
  requesterId: z.string().min(1),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(4000),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(PRIORITIES),
  source: z.enum(SOURCES),
  sessionId: z.string().nullish(),
  kbArticleId: z.string().nullish(),
  stepsTried: z
    .array(z.object({ order: z.number().int(), text: z.string().max(500), result: z.enum(["worked", "failed", "skipped"]) }))
    .max(30)
    .default([]),
  device: z.string().max(200).nullish(),
  /** Why it reached IT: the assistant's escalation reason for chat tickets, else "portal" / "email". */
  escalationReason: z.string().max(40).nullish(),
});
export type NewTicket = z.input<typeof newTicketSchema>;

export interface TicketRow {
  id: string;
  number: string;
  requester_id: string;
  team_id: string | null;
  assignee_id: string | null;
  title: string;
  description: string;
  category: string;
  priority: (typeof PRIORITIES)[number];
  status: string;
  source: string;
  session_id: string | null;
  kb_article_id: string | null;
  steps_tried: string;
  device: string | null;
  sla_due_at: number | null;
  sla_breached: number;
  first_response_at: number | null;
  resolved_at: number | null;
  closed_at: number | null;
  csat: number | null;
  workflow_instance_id: string | null;
  escalation_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreatedTicket {
  id: string;
  number: string;
  title: string;
  priority: string;
  category: string;
  team: { id: string; name: string; mailbox: string } | null;
  slaDueAt: number;
  status: "NEW";
}

/** Next INC number (INC-1001, INC-1002, …). D1 serialises writes, so UPDATE … RETURNING is race-free. */
async function nextTicketNumber(db: D1Database): Promise<string> {
  await db.prepare("INSERT INTO counters (name, value) VALUES ('ticket', 1000) ON CONFLICT(name) DO NOTHING").run();
  const row = await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'ticket' RETURNING value").first<{ value: number }>();
  return `INC-${row!.value}`;
}

export async function createTicket(env: AppEnv, input: NewTicket, now = new Date()): Promise<CreatedTicket> {
  const t = newTicketSchema.parse(input);
  const db = env.DB;

  const [team, sla] = await Promise.all([
    db
      .prepare("SELECT t.id, t.name, t.mailbox FROM routing_rules r JOIN teams t ON t.id = r.team_id WHERE r.category = ?")
      .bind(t.category)
      .first<{ id: string; name: string; mailbox: string }>(),
    db
      .prepare("SELECT resolve_minutes, working_hours_only FROM sla_policies WHERE priority = ?")
      .bind(t.priority)
      .first<{ resolve_minutes: number; working_hours_only: number }>(),
  ]);
  const fallbackMinutes = { CRITICAL: 60, HIGH: 240, MEDIUM: 480, LOW: 1080 }[t.priority];
  const slaDue = computeSlaDue(now, sla?.resolve_minutes ?? fallbackMinutes, sla ? !!sla.working_hours_only : t.priority === "LOW");

  const id = crypto.randomUUID();
  const number = await nextTicketNumber(db);
  const ts = now.getTime();
  await db.batch([
    db
      .prepare(
        `INSERT INTO tickets (id, number, requester_id, team_id, title, description, category, priority, status, source,
           session_id, kb_article_id, steps_tried, device, sla_due_at, escalation_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        number,
        t.requesterId,
        team?.id ?? null,
        t.title,
        t.description,
        t.category,
        t.priority,
        t.source,
        t.sessionId ?? null,
        t.kbArticleId ?? null,
        JSON.stringify(t.stepsTried satisfies StepTried[]),
        t.device ?? null,
        slaDue.getTime(),
        t.escalationReason ?? (t.source === "CHAT" ? "user_requested" : t.source.toLowerCase()),
        ts,
        ts,
      ),
    db
      .prepare("INSERT INTO ticket_events (id, ticket_id, actor_id, type, data, created_at) VALUES (?, ?, ?, 'created', ?, ?)")
      .bind(crypto.randomUUID(), id, t.requesterId, JSON.stringify({ source: t.source, teamId: team?.id ?? null }), ts),
    db
      .prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, created_at) VALUES (?, ?, 'ticket.create', 'ticket', ?, ?)")
      .bind(crypto.randomUUID(), t.requesterId, id, ts),
  ]);

  const created: CreatedTicket = {
    id,
    number,
    title: t.title,
    priority: t.priority,
    category: t.category,
    team: team ?? null,
    slaDueAt: slaDue.getTime(),
    status: "NEW",
  };
  await notifyBoard(env, { type: "ticket.created", ticket: { ...created, teamId: team?.id ?? null } });
  await startTicketWorkflow(env, id);
  return created;
}

/**
 * Starts the durable lifecycle for a ticket. A reopened (closed) ticket gets a fresh instance that
 * skips triage and the "new ticket" emails. Never fails ticket creation.
 */
export async function startTicketWorkflow(env: AppEnv, ticketId: string, opts: { reopened?: boolean } = {}): Promise<string | null> {
  const instanceId = opts.reopened ? `${ticketId}-r${Date.now()}` : ticketId;
  try {
    await env.TICKET_WORKFLOW.create({ id: instanceId, params: { ticketId, reopened: opts.reopened ?? false } });
    await env.DB.prepare("UPDATE tickets SET workflow_instance_id = ? WHERE id = ?").bind(instanceId, ticketId).run();
    return instanceId;
  } catch (e) {
    console.error("[workflow] could not start for", ticketId, e);
    return null;
  }
}

export type BoardEvent =
  | { type: "ticket.created"; ticket: CreatedTicket & { teamId: string | null } }
  | { type: "ticket.updated"; ticketId: string; number: string; teamId: string | null; changes: Record<string, unknown> };

/** Pushes an event to every connected IT console. Never fails the caller. */
export async function notifyBoard(env: AppEnv, event: BoardEvent): Promise<void> {
  try {
    await env.TICKET_BOARD.getByName("board").broadcast(event);
  } catch (e) {
    console.error("[board] broadcast failed", e);
  }
}

export const STAFF_ROLES = new Set(["agent", "admin"]);
