import type { AppEnv } from "../env";
import type { TicketRow } from "./tickets";

export interface TicketContext {
  ticket: TicketRow;
  stepsTried: { order: number; text: string; result: string }[];
  requester: { id: string; name: string; email: string };
  team: { id: string; name: string; mailbox: string } | null;
  assignee: { id: string; name: string; email: string } | null;
  /** IT admins (escalations, CRITICAL tickets, digest). IT_ADMIN_EMAIL wins if set. */
  adminEmails: string[];
}

/** Everything the workflow and email builders need about one ticket, in one round trip. */
export async function loadTicketContext(env: AppEnv, ticketId: string): Promise<TicketContext | null> {
  const db = env.DB;
  const ticket = await db.prepare("SELECT * FROM tickets WHERE id = ?").bind(ticketId).first<TicketRow>();
  if (!ticket) return null;
  const [requester, team, assignee, admins] = await Promise.all([
    db.prepare("SELECT id, name, email FROM user WHERE id = ?").bind(ticket.requester_id).first<{ id: string; name: string; email: string }>(),
    ticket.team_id ? db.prepare("SELECT id, name, mailbox FROM teams WHERE id = ?").bind(ticket.team_id).first<{ id: string; name: string; mailbox: string }>() : null,
    ticket.assignee_id ? db.prepare("SELECT id, name, email FROM user WHERE id = ?").bind(ticket.assignee_id).first<{ id: string; name: string; email: string }>() : null,
    db.prepare("SELECT email FROM user WHERE role = 'admin' ORDER BY created_at").all<{ email: string }>(),
  ]);
  return {
    ticket,
    stepsTried: JSON.parse(ticket.steps_tried || "[]"),
    requester: requester ?? { id: ticket.requester_id, name: "Employee", email: "" },
    team: team ?? null,
    assignee: assignee ?? null,
    adminEmails: env.IT_ADMIN_EMAIL ? [env.IT_ADMIN_EMAIL] : admins.results.map((a) => a.email),
  };
}
