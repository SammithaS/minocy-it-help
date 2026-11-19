/**
 * Public endpoints reached from emails (no login). Authenticated by signed, expiring tokens.
 *
 * GET shows a tiny confirmation page; only the POST from that page acts. Mail security scanners
 * open links automatically, so a GET must never close or reopen a ticket.
 */
import { Hono } from "hono";
import { html, raw } from "hono/html";
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
        body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #f3f6f5; font-family: "Plus Jakarta Sans", system-ui, sans-serif; color: #17262a; }
        main { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #e8eeed; border-radius: 22px; padding: 28px; }
        h1 { font-size: 22px; margin: 0 0 8px; } p { color: #55666b; line-height: 1.5; }
        button { min-height: 44px; border-radius: 999px; border: 0; padding: 0 20px; font-weight: 700; font-size: 15px; cursor: pointer; }
        .yes { background: #0b6e76; color: #fff; } .no { background: #fff; border: 1px solid #cbd7d6; color: #17262a; }
        textarea { width: 100%; box-sizing: border-box; min-height: 80px; border: 1px solid #cbd7d6; border-radius: 14px; padding: 10px; font: inherit; margin: 8px 0 12px; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; } a { color: #0b6e76; font-weight: 700; }
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
  });
