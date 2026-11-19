/**
 * One builder per email the ticket lifecycle sends. Each returns a ready-to-send OutgoingEmail.
 * Subjects keep the "[INC-1031]" prefix so replies thread and route back to the ticket.
 */
import { createElement } from "react";
import type { AppEnv } from "../env";
import type { TicketContext } from "../lib/ticket-context";
import { signLink } from "../lib/tokens";
import type { OutgoingEmail } from "./send";
import { replyAddress } from "./send";
import { TicketEmail, type TicketEmailProps } from "./templates/ticket-email";

const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };
const fmt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "—";

const email = (props: Omit<TicketEmailProps, "appUrl">, env: AppEnv) => createElement(TicketEmail, { ...props, appUrl: env.APP_URL });

function staffDetails(c: TicketContext): [string, string][] {
  const t = c.ticket;
  return [
    ["Requester", `${c.requester.name} <${c.requester.email}>`],
    ["Priority", PRIORITY_LABEL[t.priority] ?? t.priority],
    ["Team", c.team?.name ?? "Unrouted"],
    ["Device", t.device ?? "—"],
    ["Source", t.source === "CHAT" ? "Assistant chat (transcript in console)" : t.source.toLowerCase()],
    ["Guide", t.kb_article_id ?? "—"],
    ["SLA due", fmt(t.sla_due_at)],
  ];
}

const consoleLink = (env: AppEnv, n: string) => `${env.APP_URL}/tickets/${n}`;

/** New ticket → team mailbox. */
export function teamNewTicket(env: AppEnv, c: TicketContext, triageNote?: string | null): OutgoingEmail {
  const t = c.ticket;
  return {
    channel: "email_team",
    kind: "team_new",
    to: c.team?.mailbox ?? c.adminEmails[0] ?? env.EMAIL_FROM,
    subject: `[${t.number}][${PRIORITY_LABEL[t.priority]}] ${t.title}`,
    ticketId: t.id,
    replyTo: replyAddress(env, t.number),
    element: email(
      {
        preview: `${c.requester.name}: ${t.title}`,
        eyebrow: `${t.number} · ${PRIORITY_LABEL[t.priority]} · ${c.team?.name ?? "Unrouted"}`,
        heading: t.title,
        callout: t.priority === "CRITICAL" ? { tone: "critical", text: "CRITICAL — respond within 1 hour." } : undefined,
        paragraphs: [t.description, ...(triageNote ? [`Triage agent: ${triageNote}`] : [])],
        details: staffDetails(c),
        stepsTried: c.stepsTried,
        buttons: [{ label: "Open in console", href: consoleLink(env, t.number) }],
        footer: "Reply to this email to post a public comment to the employee.",
      },
      env,
    ),
  };
}

/** CRITICAL ticket → IT admin as well. */
export function adminCritical(env: AppEnv, c: TicketContext, to: string): OutgoingEmail {
  const base = teamNewTicket(env, c);
  return { ...base, channel: "email_admin", kind: "critical_admin", to, subject: `[CRITICAL] ${base.subject}` };
}

/** Confirmation → employee. */
export function employeeAck(env: AppEnv, c: TicketContext): OutgoingEmail {
  const t = c.ticket;
  return {
    channel: "email_employee",
    kind: "employee_ack",
    to: c.requester.email,
    subject: `[${t.number}] We've got your request: ${t.title}`,
    ticketId: t.id,
    replyTo: replyAddress(env, t.number),
    element: email(
      {
        preview: `${t.number} is with the ${c.team?.name ?? "IT"} team`,
        eyebrow: t.number,
        heading: `Your ticket is with the ${c.team?.name ?? "IT"} team`,
        paragraphs: [
          `Hi ${c.requester.name.split(" ")[0]}, thanks — the ${c.team?.name ?? "IT"} team has your request and everything you've already tried, so you won't need to explain it again.`,
          `We aim to sort it by ${fmt(t.sla_due_at)}.`,
        ],
        details: [
          ["Ticket", `${t.number} — ${t.title}`],
          ["Priority", PRIORITY_LABEL[t.priority] ?? t.priority],
        ],
        buttons: [{ label: "View your ticket", href: consoleLink(env, t.number) }],
        footer: "Reply to this email to add details to your ticket.",
      },
      env,
    ),
  };
}

/** 75% of the SLA gone with no response → team reminder. */
export function slaReminder(env: AppEnv, c: TicketContext): OutgoingEmail {
  const t = c.ticket;
  return {
    channel: "email_team",
    kind: "sla_reminder",
    to: c.team?.mailbox ?? c.adminEmails[0] ?? env.EMAIL_FROM,
    subject: `[${t.number}] Reminder: no response yet — SLA due ${fmt(t.sla_due_at)}`,
    ticketId: t.id,
    replyTo: replyAddress(env, t.number),
    element: email(
      {
        preview: `${t.number} needs a first response`,
        eyebrow: `${t.number} · SLA reminder`,
        heading: "This ticket hasn't had a response yet",
        callout: { tone: "info", text: `SLA due ${fmt(t.sla_due_at)}.` },
        paragraphs: [t.title],
        details: staffDetails(c),
        buttons: [{ label: "Respond now", href: consoleLink(env, t.number) }],
      },
      env,
    ),
  };
}

/** SLA breached → IT admin. */
export function slaEscalation(env: AppEnv, c: TicketContext, to: string): OutgoingEmail {
  const t = c.ticket;
  return {
    channel: "email_admin",
    kind: "sla_escalation",
    to,
    subject: `[${t.number}] SLA breached — ${t.title}`,
    ticketId: t.id,
    element: email(
      {
        preview: `${t.number} breached its SLA`,
        eyebrow: `${t.number} · Escalation`,
        heading: "SLA breached without a response",
        callout: { tone: "critical", text: `Due ${fmt(t.sla_due_at)} · team ${c.team?.name ?? "Unrouted"} · no first response.` },
        paragraphs: [t.title],
        details: staffDetails(c),
        buttons: [{ label: "Open in console", href: consoleLink(env, t.number) }],
        footer: "You're receiving this as an IT admin.",
      },
      env,
    ),
  };
}

/** Resolved → employee: "Did this fix it?" with signed Yes/No links. */
export async function resolvedConfirm(env: AppEnv, c: TicketContext, resolutionNote: string, confirmDays: number): Promise<OutgoingEmail> {
  const t = c.ticket;
  const token = await signLink(env.BETTER_AUTH_SECRET, { purpose: "confirm", sub: t.id, exp: Date.now() + (confirmDays + 1) * 86_400_000 });
  const link = (answer: "yes" | "no") => `${env.APP_URL}/api/public/confirm?t=${encodeURIComponent(token)}&a=${answer}`;
  return {
    channel: "email_employee",
    kind: "resolved_confirm",
    to: c.requester.email,
    subject: `[${t.number}] Resolved — did this fix it?`,
    ticketId: t.id,
    replyTo: replyAddress(env, t.number),
    element: email(
      {
        preview: "Let us know if it's working now",
        eyebrow: `${t.number} · Resolved`,
        heading: "We think this is fixed — is it?",
        paragraphs: [
          `Hi ${c.requester.name.split(" ")[0]}, the ${c.team?.name ?? "IT"} team marked "${t.title}" as resolved.`,
          ...(resolutionNote ? [`What they did: ${resolutionNote}`] : []),
          `If we don't hear back in ${confirmDays} days we'll close the ticket.`,
        ],
        buttons: [
          { label: "Yes, it's fixed", href: link("yes") },
          { label: "No, still broken", href: link("no"), tone: "outline" },
        ],
        footer: "You can also reply to this email.",
      },
      env,
    ),
  };
}

/** Employee said "No" → team. */
export function reopenedNotice(env: AppEnv, c: TicketContext, reason: string): OutgoingEmail {
  const t = c.ticket;
  return {
    channel: "email_team",
    kind: "reopened",
    to: c.assignee?.email ?? c.team?.mailbox ?? c.adminEmails[0] ?? env.EMAIL_FROM,
    subject: `[${t.number}] Reopened by ${c.requester.name}`,
    ticketId: t.id,
    replyTo: replyAddress(env, t.number),
    element: email(
      {
        preview: `${c.requester.name} says it's still not fixed`,
        eyebrow: `${t.number} · Reopened`,
        heading: "The employee says it's still not fixed",
        paragraphs: [t.title, ...(reason ? [`They said: ${reason}`] : [])],
        details: staffDetails(c),
        buttons: [{ label: "Open in console", href: consoleLink(env, t.number) }],
      },
      env,
    ),
  };
}

export interface DigestStats {
  date: string;
  newTickets: number;
  open: number;
  breached: number;
  topCategories: [string, number][];
  assistantResolutionRate: number | null;
  chats: number;
}

/** Daily 09:00 IST digest → IT admins. */
export function dailyDigest(env: AppEnv, to: string, s: DigestStats): OutgoingEmail {
  return {
    channel: "email_admin",
    kind: "digest",
    to,
    subject: `IT Help daily digest — ${s.date}: ${s.newTickets} new, ${s.open} open, ${s.breached} breached`,
    element: email(
      {
        preview: `${s.newTickets} new tickets, ${s.breached} breached`,
        eyebrow: `Daily digest · ${s.date}`,
        heading: "Yesterday in IT Help",
        callout: s.breached ? { tone: "critical", text: `${s.breached} open ticket(s) have breached their SLA.` } : undefined,
        paragraphs: [],
        details: [
          ["New tickets (24 h)", String(s.newTickets)],
          ["Open now", String(s.open)],
          ["SLA breached (open)", String(s.breached)],
          ["Chats (24 h)", String(s.chats)],
          ["Solved by the assistant", s.assistantResolutionRate === null ? "—" : `${Math.round(s.assistantResolutionRate * 100)}%`],
          ["Top categories", s.topCategories.length ? s.topCategories.map(([k, n]) => `${k} (${n})`).join(", ") : "—"],
        ],
        buttons: [{ label: "Open the console", href: `${env.APP_URL}/console` }],
        footer: "Sent daily at 09:00 IST.",
      },
      env,
    ),
  };
}
