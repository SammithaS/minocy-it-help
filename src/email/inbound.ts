/**
 * Inbound email (Cloudflare Email Routing → the Worker's email() handler).
 *
 *   help@<domain>                → new ticket (source EMAIL) for a known employee
 *   ticket+INC-1031@<domain>     → comment on that ticket (requester or IT staff)
 *   anything else / unknown user → rejected with a friendly bounce
 */
import PostalMime from "postal-mime";
import type { AppEnv } from "../env";
import { searchKb } from "../rag/search";
import { getTicketByNumber, markFirstResponse } from "../lib/ticket-actions";
import { createTicket, notifyBoard, STAFF_ROLES } from "../lib/tickets";
import { TICKET_CATEGORIES, type TicketCategory } from "../org-config";

const MAX_RAW_BYTES = 5 * 1024 * 1024;
const NEW_TICKET_BOXES = new Set(["help", "it", "support", "helpdesk"]);

/** Keeps only the new part of a reply: drops quoted history and signatures. */
export function stripReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{0,200}wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From:\s.+/i.test(line.trim())) break;
    if (/^--\s*$/.test(line)) break; // signature delimiter
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const cleanSubject = (s: string) => s.replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, "").replace(/\[INC-\d+\]/gi, "").trim();

export async function handleInboundEmail(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large for IT Help (max 5 MB). Please describe the problem in a smaller email.");
    return;
  }
  const parsed = await PostalMime.parse(message.raw);
  const fromEmail = (parsed.from?.address ?? message.from).toLowerCase();
  const sender = await env.DB.prepare("SELECT id, name, role FROM user WHERE email = ?").bind(fromEmail).first<{ id: string; name: string; role: string }>();
  if (!sender) {
    message.setReject(`Sorry — ${fromEmail} isn't registered with Minocy IT Help. Use your work email, or call the helpdesk.`);
    return;
  }

  const local = message.to.toLowerCase().split("@")[0] ?? "";
  const body = stripReply(parsed.text ?? (parsed.html ?? "").replace(/<[^>]+>/g, " ")).slice(0, 4000);

  // Reply to a ticket → comment.
  const reply = local.match(/^ticket\+(inc-\d+)$/i);
  if (reply) {
    const t = await getTicketByNumber(env, reply[1]!.toUpperCase());
    const staff = STAFF_ROLES.has(sender.role);
    if (!t || (!staff && t.requester_id !== sender.id)) {
      message.setReject("We couldn't match this reply to one of your tickets.");
      return;
    }
    if (!body) return; // empty reply (e.g. only quoted text) — nothing to add
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'public', 'email', ?)").bind(
        crypto.randomUUID(),
        t.id,
        sender.id,
        body,
        now,
      ),
      env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(now, t.id),
    ]);
    if (staff) await markFirstResponse(env, t);
    await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { comment: "email" } });
    return;
  }

  // New request → ticket.
  if (NEW_TICKET_BOXES.has(local)) {
    const subject = cleanSubject(parsed.subject ?? "");
    const title = (subject.length >= 5 ? subject : body.split("\n")[0] ?? "Email request").slice(0, 120);
    const description = (body.length >= 10 ? body : `${subject}\n\n(sent by email with no further details)`).slice(0, 4000);

    // Best guess at the team from the KB; the Triage agent refines it in the workflow.
    let category: TicketCategory = "software";
    let priority: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
    try {
      const r = await searchKb({ db: env.DB, ai: env.AI, vectorize: env.VECTORIZE }, `${title}\n${description}`.slice(0, 500), { limit: 1 });
      const hit = r.hits[0];
      if (r.confident && hit && (TICKET_CATEGORIES as readonly string[]).includes(hit.ticketCategory)) {
        category = hit.ticketCategory as TicketCategory;
        if (hit.priority === "HIGH" || hit.priority === "LOW") priority = hit.priority;
      }
    } catch (e) {
      console.warn("[inbound] KB lookup failed, using defaults:", e instanceof Error ? e.message : e);
    }
    const device = await env.DB.prepare("SELECT model, os, asset_tag FROM devices WHERE user_id = ?").bind(sender.id).first<{ model: string; os: string; asset_tag: string }>();
    await createTicket(env, {
      requesterId: sender.id,
      title: title.length >= 5 ? title : `Email: ${title}`,
      description,
      category,
      priority,
      source: "EMAIL",
      device: device ? `${device.model} (${device.os}, ${device.asset_tag})` : null,
    });
    return;
  }

  message.setReject("This address doesn't accept mail. Write to help@ to raise a ticket.");
}
