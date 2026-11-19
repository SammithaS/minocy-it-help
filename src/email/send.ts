/**
 * Outgoing email for tickets. Every message is rendered with React Email and recorded in the
 * `notifications` table (the console Outbox), whatever the transport:
 *
 *   EMAIL_TRANSPORT=log   (default) render + store only — works with no domain or accounts
 *   EMAIL_TRANSPORT=live  team/admin mail → Cloudflare Email Service (`send_email` binding, verified
 *                         destination addresses, free); employee mail → Resend
 *
 * A failed live send is recorded and then thrown, so a Workflow step retries it.
 */
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import type { AppEnv } from "../env";

export type EmailChannel = "email_team" | "email_employee" | "email_admin";

export interface OutgoingEmail {
  channel: EmailChannel;
  kind: string;
  to: string;
  subject: string;
  element: ReactElement;
  ticketId?: string | null;
  replyTo?: string | null;
}

export interface SendResult {
  status: "sent" | "logged" | "failed";
  transport: "log" | "email-service" | "resend";
  notificationId: string;
}

async function viaResend(env: AppEnv, e: OutgoingEmail, html: string, text: string) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [e.to], subject: e.subject, html, text, ...(e.replyTo ? { reply_to: e.replyTo } : {}) }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function viaEmailService(env: AppEnv, e: OutgoingEmail, html: string, text: string) {
  await env.EMAIL.send({
    from: { name: "Minocy IT Help", email: env.EMAIL_FROM },
    to: e.to,
    subject: e.subject,
    html,
    text,
    ...(e.replyTo ? { replyTo: e.replyTo } : {}),
  });
}

export async function sendEmail(env: AppEnv, e: OutgoingEmail): Promise<SendResult> {
  const [html, text] = await Promise.all([render(e.element), render(e.element, { plainText: true })]);
  const live = env.EMAIL_TRANSPORT === "live";
  const transport: SendResult["transport"] = !live ? "log" : e.channel === "email_employee" ? "resend" : "email-service";

  let status: SendResult["status"] = live ? "sent" : "logged";
  let error: string | null = null;
  if (live) {
    try {
      if (transport === "resend") await viaResend(env, e, html, text);
      else await viaEmailService(env, e, html, text);
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    console.log(`[email:${e.kind}] to=${e.to} subject="${e.subject}"`);
  }

  const notificationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notifications (id, ticket_id, channel, kind, recipient, subject, transport, status, error, html, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(notificationId, e.ticketId ?? null, e.channel, e.kind, e.to, e.subject, transport, status, error, html, text, Date.now())
    .run();

  if (status === "failed") throw new Error(`Email ${e.kind} to ${e.to} failed: ${error}`);
  return { status, transport, notificationId };
}

/** Address that turns replies into ticket comments (see src/email/inbound.ts). */
export const replyAddress = (env: AppEnv, ticketNumber: string) => `ticket+${ticketNumber}@${env.INBOUND_DOMAIN}`;
