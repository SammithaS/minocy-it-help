/**
 * Emails for access requests and self-service password reset. Same React Email template as tickets.
 * Anything carrying a secret (reset code, set-password link) is marked `sensitive` so the Outbox
 * doesn't keep its content.
 */
import { createElement } from "react";
import type { AppEnv } from "../env";
import type { AccessContext } from "../lib/access";
import { signLink } from "../lib/tokens";
import type { OutgoingEmail } from "./send";
import { TicketEmail, type TicketEmailProps } from "./templates/ticket-email";

const email = (props: Omit<TicketEmailProps, "appUrl">, env: AppEnv) => createElement(TicketEmail, { ...props, appUrl: env.APP_URL });
const first = (name: string) => name.split(" ")[0];
const myRequests = (env: AppEnv) => `${env.APP_URL}/tickets`;

function details(r: AccessContext): [string, string][] {
  return [
    ["Request", r.number],
    ["App", r.app_name],
    ["Requested by", `${r.requester_name}${r.department ? ` (${r.department})` : ""}`],
    ["Why", r.justification],
  ];
}

/** → approver (manager / owner team): signed Approve / Reject links. GET shows a page; only its POST acts. */
export async function accessApprovalRequest(env: AppEnv, r: AccessContext, days: number): Promise<OutgoingEmail> {
  const token = await signLink(env.BETTER_AUTH_SECRET, { purpose: "access-decision", sub: r.id, exp: Date.now() + (days + 1) * 86_400_000 });
  const link = (a: "approve" | "reject") => `${env.APP_URL}/api/public/access?t=${encodeURIComponent(token)}&a=${a}`;
  return {
    channel: r.approver_id ? "email_employee" : "email_team",
    kind: "access_approval",
    to: r.approver_email!,
    subject: `[${r.number}] ${r.requester_name} is asking for ${r.app_name} access`,
    element: email(
      {
        preview: `Approve or reject ${r.requester_name}'s ${r.app_name} request`,
        eyebrow: `${r.number} · Access request`,
        heading: `${r.requester_name} needs ${r.app_name}`,
        paragraphs: [
          `${r.approver_name ? `Hi ${first(r.approver_name)}, ` : ""}${first(r.requester_name)} asked the IT assistant for access to ${r.app_name}. As their approver, please approve or reject it.`,
          `If nobody answers in ${days} days the request expires.`,
        ],
        details: details(r),
        buttons: [
          { label: "Approve", href: link("approve") },
          { label: "Reject", href: link("reject"), tone: "outline" },
        ],
        footer: "You'll see a confirmation page before anything happens.",
      },
      env,
    ),
  };
}

/** → requester: "sent to your manager". */
export function accessSubmitted(env: AppEnv, r: AccessContext): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: "access_submitted",
    to: r.requester_email,
    subject: `[${r.number}] Your ${r.app_name} request is with ${r.approver_name ?? "your approver"}`,
    element: email(
      {
        preview: `Waiting for approval`,
        eyebrow: r.number,
        heading: `Your ${r.app_name} request is waiting for approval`,
        paragraphs: [
          `Hi ${first(r.requester_name)}, we've asked ${r.approver_name ?? r.approver_email ?? "your approver"} to approve your request. Once they do, access is set up automatically and we'll email you.`,
        ],
        details: details(r),
        buttons: [{ label: "View your requests", href: myRequests(env) }],
        footer: "No action needed from you.",
      },
      env,
    ),
  };
}

/** → requester: granted. */
export function accessGranted(env: AppEnv, r: AccessContext): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: "access_granted",
    to: r.requester_email,
    subject: `[${r.number}] You now have access to ${r.app_name}`,
    element: email(
      {
        preview: `${r.app_name} is ready`,
        eyebrow: `${r.number} · Provisioned`,
        heading: `You're in — ${r.app_name} is ready`,
        callout: { tone: "info", text: r.provision_detail ?? "Sign in with your usual company account." },
        paragraphs: [`Hi ${first(r.requester_name)}, your request was approved${r.decision_note ? ` with a note: "${r.decision_note}"` : ""} and your access has been set up.`],
        buttons: [{ label: "View your requests", href: myRequests(env) }],
        footer: "Something not working? Ask IT in the portal.",
      },
      env,
    ),
  };
}

/** → owner team: FYI, for their licence count. */
export function accessProvisionedTeam(env: AppEnv, r: AccessContext): OutgoingEmail | null {
  if (!r.team_mailbox) return null;
  return {
    channel: "email_team",
    kind: "access_provisioned",
    to: r.team_mailbox,
    subject: `[${r.number}] ${r.app_name} provisioned for ${r.requester_name}`,
    element: email(
      {
        preview: `${r.app_name} licence assigned`,
        eyebrow: `${r.number} · FYI`,
        heading: `${r.app_name} access provisioned`,
        paragraphs: [`Approved by ${r.approver_name ?? r.approver_email ?? "auto-approval"} and provisioned automatically. No action needed.`],
        details: details(r),
        footer: "Sent to the app's owner team.",
      },
      env,
    ),
  };
}

/** → requester: rejected or expired. */
export function accessNotGranted(env: AppEnv, r: AccessContext, why: "rejected" | "expired"): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: why === "rejected" ? "access_rejected" : "access_expired",
    to: r.requester_email,
    subject: `[${r.number}] Your ${r.app_name} request was ${why === "rejected" ? "not approved" : "not answered in time"}`,
    element: email(
      {
        preview: why === "rejected" ? "Not approved" : "Request expired",
        eyebrow: r.number,
        heading: why === "rejected" ? `Your ${r.app_name} request wasn't approved` : `Your ${r.app_name} request expired`,
        paragraphs: [
          why === "rejected"
            ? `Hi ${first(r.requester_name)}, ${r.approver_name ?? "your approver"} didn't approve this request${r.decision_note ? `: "${r.decision_note}"` : "."}`
            : `Hi ${first(r.requester_name)}, your approver didn't answer in time, so the request was closed.`,
          `If you still need it, talk to your manager and ask again in IT Help.`,
        ],
        buttons: [{ label: "Open IT Help", href: env.APP_URL }],
      },
      env,
    ),
  };
}

/** → requester: GitHub sent an invite that they must accept. */
export function accessInvitePending(env: AppEnv, r: AccessContext, detail: string): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: "access_invite_pending",
    to: r.requester_email,
    subject: `[${r.number}] Accept your ${r.app_name} invite`,
    element: email(
      {
        preview: "One last step: accept the invite",
        eyebrow: `${r.number} · Approved`,
        heading: `Accept your ${r.app_name} invite`,
        callout: { tone: "info", text: detail },
        paragraphs: [
          `Hi ${first(r.requester_name)}, your request was approved. ${r.connector === "github" ? "GitHub has emailed you an invitation — accept it there, or at github.com/orgs/<org>/invitation." : "Accept the invitation you've been sent."}`,
          "We'll confirm here once you're in. Invites expire after 7 days.",
        ],
        buttons: r.connector === "github" ? [{ label: "Open GitHub", href: "https://github.com/settings/organizations" }] : [],
        footer: "No reply needed.",
      },
      env,
    ),
  };
}

/** → requester: provisioning failed, IT has a ticket. */
export function accessProvisionFailed(env: AppEnv, r: AccessContext, ticket: string): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: "access_failed",
    to: r.requester_email,
    subject: `[${r.number}] We couldn't set up ${r.app_name} automatically`,
    element: email(
      {
        preview: `IT is on it (${ticket})`,
        eyebrow: `${r.number} · Needs IT`,
        heading: `${r.app_name} needs a hand from IT`,
        paragraphs: [
          `Hi ${first(r.requester_name)}, your request was approved, but setting up ${r.app_name} automatically didn't work. We've raised ${ticket} with the ${r.team_name ?? "IT"} team, who'll finish it for you.`,
        ],
        buttons: [{ label: `View ${ticket}`, href: `${env.APP_URL}/tickets/${ticket}` }],
        footer: "You don't need to do anything.",
      },
      env,
    ),
  };
}

// ─────────────────────────── password reset ───────────────────────────

export function passwordResetCode(env: AppEnv, to: string, name: string, code: string, minutes: number): OutgoingEmail {
  return {
    channel: "email_employee",
    kind: "password_code",
    to,
    sensitive: true,
    subject: `Your Minocy password reset code: ${code}`,
    element: email(
      {
        preview: `Code ${code} — valid ${minutes} minutes`,
        eyebrow: "Password reset",
        heading: `Your code is ${code}`,
        paragraphs: [
          `Hi ${first(name)}, enter this code in the IT Help chat to confirm it's you. It expires in ${minutes} minutes.`,
          `Didn't ask to reset your password? Ignore this email — nothing changes — and tell IT if it keeps happening.`,
        ],
        footer: "IT will never ask you for this code.",
      },
      env,
    ),
  };
}
