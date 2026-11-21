/**
 * Public endpoints reached from emails (no login). Authenticated by signed, expiring tokens.
 *
 * GET shows a tiny confirmation page; only the POST from that page acts. Mail security scanners
 * open links automatically, so a GET must never close or reopen a ticket.
 */
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { decideAccessRequest, loadAccessContext } from "../lib/access";
import { checkSetPasswordLink, setNewPassword } from "../lib/password-reset";
import { confirmResolution } from "../lib/ticket-actions";
import { verifyLink } from "../lib/tokens";
import type { HonoEnv } from "./context";

const page = (title: string, body: ReturnType<typeof html> | string) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title} · Minocy IT Help</title>
      <style>
        body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #f4f7fb; font-family: Inter, system-ui, sans-serif; color: #0f1b2d; }
        main { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #e3e8f0; border-radius: 16px; padding: 28px; }
        h1 { font-size: 22px; margin: 0 0 8px; } p { color: #52607a; line-height: 1.5; }
        button { min-height: 44px; border-radius: 999px; border: 0; padding: 0 20px; font-weight: 700; font-size: 15px; cursor: pointer; }
        .yes { background: #1d4ed8; color: #fff; } .no { background: #fff; border: 1px solid #cbd5e1; color: #0f1b2d; }
        input[type=password] { width: 100%; box-sizing: border-box; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 14px; padding: 0 12px; font: inherit; margin: 6px 0 12px; }
        .err { background: #fee2e2; color: #b91c1c; border-radius: 12px; padding: 10px 12px; font-weight: 600; }
        dl { background: #f4f7fb; border-radius: 14px; padding: 12px 16px; margin: 12px 0; } dt { color: #52607a; font-size: 13px; } dd { margin: 0 0 8px; }
        textarea { width: 100%; box-sizing: border-box; min-height: 80px; border: 1px solid #cbd5e1; border-radius: 14px; padding: 10px; font: inherit; margin: 8px 0 12px; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; } a { color: #1d4ed8; font-weight: 700; }
      </style>
    </head>
    <body>
      <main>${body}</main>
    </body>
  </html>`;

export const publicRoutes = new Hono<HonoEnv>()
  .get("/public/confirm", async (c) => {
    const token = c.req.query("t") ?? "";
    const answer = c.req.query("a") === "no" ? "no" : "yes";
    const payload = await verifyLink(c.env.BETTER_AUTH_SECRET, token, "confirm");
    if (!payload) return c.html(page("Link expired", html`<h1>This link has expired</h1><p>Open your ticket in <a href="${c.env.APP_URL}/tickets">IT Help</a> instead.</p>`), 410);
    const t = await c.env.DB.prepare("SELECT number, title, status FROM tickets WHERE id = ?").bind(payload.sub).first<{ number: string; title: string; status: string }>();
    if (!t) return c.html(page("Not found", html`<h1>Ticket not found</h1>`), 404);
    if (t.status !== "RESOLVED") {
      return c.html(page("Already done", html`<h1>Thanks — already recorded</h1><p>${t.number} is now ${t.status.toLowerCase().replace("_", " ")}.</p><p><a href="${c.env.APP_URL}/tickets/${t.number}">View the ticket</a></p>`));
    }
    return c.html(
      page(
        "Did this fix it?",
        html`<h1>${t.number}: did this fix it?</h1>
          <p>${t.title}</p>
          <form method="post">
            <input type="hidden" name="t" value="${token}" />
            ${answer === "no"
              ? html`<label for="reason">What's still wrong? (optional)</label><textarea id="reason" name="reason" maxlength="1000"></textarea>
                  <div class="row"><button class="no" name="a" value="no">Reopen the ticket</button><button class="yes" name="a" value="yes">Actually, it's fixed</button></div>`
              : html`<div class="row"><button class="yes" name="a" value="yes">Yes, it's fixed</button><button class="no" name="a" value="no">No, still broken</button></div>`}
          </form>`,
      ),
    );
  })
  .post("/public/confirm", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.t ?? "");
    const answer = form.a === "no" ? "no" : "yes";
    const reason = String(form.reason ?? "").trim().slice(0, 1000) || undefined;
    const payload = await verifyLink(c.env.BETTER_AUTH_SECRET, token, "confirm");
    if (!payload) return c.html(page("Link expired", html`<h1>This link has expired</h1>`), 410);
    const t = await c.env.DB.prepare(
      "SELECT id, number, team_id, status, assignee_id, first_response_at, workflow_instance_id, requester_id FROM tickets WHERE id = ?",
    )
      .bind(payload.sub)
      .first<Parameters<typeof confirmResolution>[1]>();
    if (!t) return c.html(page("Not found", html`<h1>Ticket not found</h1>`), 404);
    const result = await confirmResolution(c.env, t, answer, reason);
    const msg =
      result === "closed"
        ? "Great — we've closed the ticket. Thanks for letting us know."
        : result === "reopened"
          ? "Sorry it's still not right. We've reopened the ticket and told the team."
          : "Thanks — this was already recorded.";
    return c.html(page("Thanks", html`<h1>${raw(result === "closed" ? "Thanks! 🎉" : "Got it")}</h1><p>${msg}</p><p><a href="${c.env.APP_URL}/tickets/${t.number}">View ${t.number}</a></p>`));
  })
  // ── Access requests: the approver's Approve / Reject links ──
  .get("/public/access", async (c) => {
    const token = c.req.query("t") ?? "";
    const answer = c.req.query("a") === "reject" ? "reject" : "approve";
    const payload = await verifyLink(c.env.BETTER_AUTH_SECRET, token, "access-decision");
    if (!payload) return c.html(page("Link expired", html`<h1>This link has expired</h1><p>The request has expired or was replaced.</p>`), 410);
    const r = await loadAccessContext(c.env, payload.sub);
    if (!r) return c.html(page("Not found", html`<h1>Request not found</h1>`), 404);
    if (r.status !== "PENDING") {
      return c.html(page("Already decided", html`<h1>Already decided</h1><p>${r.number} (${r.app_name} for ${r.requester_name}) is ${r.status.toLowerCase()}.</p>`));
    }
    return c.html(
      page(
        `${r.number}: ${r.app_name} access`,
        html`<h1>${r.requester_name} needs ${r.app_name}</h1>
          <dl>
            <dt>Request</dt><dd>${r.number}</dd>
            <dt>Requested by</dt><dd>${r.requester_name}${r.department ? ` (${r.department})` : ""}</dd>
            <dt>Why</dt><dd>${r.justification}</dd>
          </dl>
          <form method="post">
            <input type="hidden" name="t" value="${token}" />
            <label for="note">${answer === "reject" ? "Reason (shared with them, optional)" : "Note (optional)"}</label>
            <textarea id="note" name="note" maxlength="500"></textarea>
            <div class="row">
              ${answer === "reject"
                ? html`<button class="no" name="a" value="reject">Reject</button><button class="yes" name="a" value="approve">Approve instead</button>`
                : html`<button class="yes" name="a" value="approve">Approve access</button><button class="no" name="a" value="reject">Reject</button>`}
            </div>
          </form>`,
      ),
    );
  })
  .post("/public/access", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.t ?? "");
    const decision = form.a === "reject" ? "reject" : "approve";
    const note = String(form.note ?? "").trim().slice(0, 500) || null;
    const payload = await verifyLink(c.env.BETTER_AUTH_SECRET, token, "access-decision");
    if (!payload) return c.html(page("Link expired", html`<h1>This link has expired</h1>`), 410);
    const r = await loadAccessContext(c.env, payload.sub);
    if (!r) return c.html(page("Not found", html`<h1>Request not found</h1>`), 404);
    const result = await decideAccessRequest(c.env, r.id, decision, note, { id: r.approver_id, email: r.approver_email });
    const text =
      result === "approved"
        ? `Approved. ${r.requester_name.split(" ")[0]} will get ${r.app_name} automatically and we'll let them know.`
        : result === "rejected"
          ? `Rejected. We've let ${r.requester_name.split(" ")[0]} know.`
          : "This request was already decided — nothing changed.";
    return c.html(page("Thanks", html`<h1>${result === "approved" ? "Approved ✓" : result === "rejected" ? "Rejected" : "Already decided"}</h1><p>${text}</p>`));
  })
  // ── Self-service password reset: the one-time "set a new password" link (mock SSO page) ──
  .get("/public/password", async (c) => {
    const token = c.req.query("t") ?? "";
    const link = await checkSetPasswordLink(c.env, token);
    if (!link.ok) return c.html(page("Link not valid", expiredPassword(c.env.APP_URL, link.reason)), 410);
    return c.html(page("Set a new password", passwordForm(token, link.username)));
  })
  .post("/public/password", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.t ?? "");
    const r = await setNewPassword(c.env, token, String(form.password ?? ""), String(form.confirm ?? ""));
    if (r.ok) return c.html(page("Password changed", html`<h1>Password changed ✓</h1><p>Sign in with your new password on your laptop and in Minocy apps. You can close this page.</p>`));
    if (r.reason === "expired" || r.reason === "used") return c.html(page("Link not valid", expiredPassword(c.env.APP_URL, r.reason)), 410);
    const link = await checkSetPasswordLink(c.env, token);
    return c.html(page("Set a new password", passwordForm(token, link.ok ? link.username : "", r.message)), 400);
  });

function passwordForm(token: string, username: string, error?: string) {
  return html`<h1>Choose a new password</h1>
    <p>For <strong>${username}</strong>. At least 12 characters, mixing three of: lowercase, uppercase, numbers, symbols.</p>
    ${error ? html`<p class="err" role="alert">${error}</p>` : ""}
    <form method="post" autocomplete="off">
      <input type="hidden" name="t" value="${token}" />
      <input type="hidden" name="username" value="${username}" autocomplete="username" />
      <label for="pw">New password</label>
      <input id="pw" type="password" name="password" minlength="12" maxlength="128" required autocomplete="new-password" />
      <label for="pw2">Type it again</label>
      <input id="pw2" type="password" name="confirm" minlength="12" maxlength="128" required autocomplete="new-password" />
      <div class="row"><button class="yes">Set password</button></div>
    </form>`;
}

function expiredPassword(appUrl: string, reason: "expired" | "used") {
  return html`<h1>${reason === "used" ? "This link was already used" : "This link has expired"}</h1>
    <p>For your security, reset links work once and only for 30 minutes. Ask again in <a href="${appUrl}/chat">IT Help</a>.</p>`;
}
