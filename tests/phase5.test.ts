import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { computeDigest, sendDailyDigest } from "../src/email/digest";
import { handleInboundEmail, stripReply } from "../src/email/inbound";
import type { AppEnv } from "../src/env";
import { createTicket } from "../src/lib/tickets";
import { signLink, verifyLink } from "../src/lib/tokens";

const E = env as AppEnv;
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const post = (body: unknown, cookie: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie },
  body: JSON.stringify(body),
});

async function signIn(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  await call("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, type: "sign-in" }) });
  const otp = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`to=${email}`))?.match(/code is (\d{6})/)?.[1];
  log.mockRestore();
  const res = await call("/api/auth/sign-in/email-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, otp }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const ticketRow = (number: string) =>
  E.DB.prepare("SELECT id, status, sla_breached, first_response_at, closed_at, assignee_id, workflow_instance_id FROM tickets WHERE number = ?").bind(number).first<{
    id: string;
    status: string;
    sla_breached: number;
    first_response_at: number | null;
    closed_at: number | null;
    assignee_id: string | null;
    workflow_instance_id: string | null;
  }>();
const emailsFor = async (ticketId: string) =>
  (await E.DB.prepare("SELECT kind, recipient FROM notifications WHERE ticket_id = ? ORDER BY created_at").bind(ticketId).all<{ kind: string; recipient: string }>()).results;

/** A ticket with no workflow (inserted directly), for testing the API paths in isolation. */
async function bareTicket(number: string, status = "NEW", team = "team-network") {
  const id = crypto.randomUUID();
  await E.DB.prepare(
    "INSERT INTO tickets (id, number, requester_id, team_id, title, description, category, priority, status, source, steps_tried, sla_due_at) VALUES (?, ?, 'e1', ?, 'Bare ticket', 'For API tests only', 'network', 'MEDIUM', ?, 'PORTAL', '[]', ?)",
  )
    .bind(id, number, team, status, Date.now() + 3_600_000)
    .run();
  return id;
}

let emp: string, netAgent: string, hwAgent: string;

beforeAll(async () => {
  const stmts = [
    "DELETE FROM notifications", "DELETE FROM agent_runs", "DELETE FROM ticket_comments", "DELETE FROM ticket_events", "DELETE FROM audit_log", "DELETE FROM tickets",
    "DELETE FROM team_members", "DELETE FROM routing_rules", "DELETE FROM sla_policies", "DELETE FROM teams", "DELETE FROM chat_sessions",
    "DELETE FROM session", "DELETE FROM verification", "DELETE FROM devices", "DELETE FROM user", "DELETE FROM counters",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-network', 'Network', 'net@team.example'), ('team-hardware', 'Hardware', 'hw@team.example')",
    "INSERT INTO routing_rules (category, team_id) VALUES ('network', 'team-network'), ('hardware', 'team-hardware'), ('software', 'team-network')",
    "INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only) VALUES ('CRITICAL', 60, 0), ('HIGH', 240, 0), ('MEDIUM', 480, 0), ('LOW', 1080, 1)",
    "INSERT INTO user (id, name, email, email_verified, role) VALUES ('e1', 'Emp One', 'e1@minocy.example', 1, 'employee'), ('a1', 'Net Agent', 'a1@minocy.example', 1, 'agent'), ('a3', 'Net Agent Two', 'a3@minocy.example', 1, 'agent'), ('a2', 'HW Agent', 'a2@minocy.example', 1, 'agent'), ('adm', 'Admin', 'admin@minocy.example', 1, 'admin')",
    "INSERT INTO team_members (team_id, user_id) VALUES ('team-network', 'a1'), ('team-network', 'a3'), ('team-hardware', 'a2')",
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
  emp = await signIn("e1@minocy.example");
  netAgent = await signIn("a1@minocy.example");
  hwAgent = await signIn("a2@minocy.example");
});

describe("TicketWorkflow", () => {
  it("notifies, escalates a breached SLA, then closes after the employee confirms", async () => {
    await using wf = await introspectWorkflow(E.TICKET_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.forceEventTimeout({ name: "first-response" });
      await m.forceEventTimeout({ name: "first-response-after-reminder" });
      await m.mockEvent({ type: "resolved", payload: { note: "Replaced the access point.", byUserId: "a1" } });
      await m.mockEvent({ type: "user-confirmed", payload: { answer: "yes" } });
    });

    const t = await createTicket(E, { requesterId: "e1", title: "Wi-Fi drops on floor 3", description: "Disconnects every few minutes since Monday.", category: "network", priority: "CRITICAL", source: "CHAT" });
    await E.DB.prepare("UPDATE tickets SET status = 'RESOLVED' WHERE id = ?").bind(t.id).run(); // what the console's resolve does

    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "closed", round: 1 });

    const kinds = (await emailsFor(t.id)).map((e) => e.kind);
    expect(kinds).toEqual(["team_new", "critical_admin", "employee_ack", "sla_reminder", "sla_escalation", "resolved_confirm"]);
    const emails = await emailsFor(t.id);
    expect(emails.find((e) => e.kind === "team_new")?.recipient).toBe("net@team.example");
    expect(emails.find((e) => e.kind === "employee_ack")?.recipient).toBe("e1@minocy.example");
    expect(emails.find((e) => e.kind === "sla_escalation")?.recipient).toBe("admin@minocy.example");

    const row = await ticketRow(t.number);
    expect(row).toMatchObject({ status: "CLOSED", sla_breached: 1, workflow_instance_id: t.id });
    const events = (await E.DB.prepare("SELECT type FROM ticket_events WHERE ticket_id = ? ORDER BY created_at").bind(t.id).all<{ type: string }>()).results.map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["created", "triaged", "sla_reminder", "escalated", "closed"]));
  });

  it("skips SLA emails after a first response, and reopens when the employee says no", async () => {
    await using wf = await introspectWorkflow(E.TICKET_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "first-response", payload: { at: Date.now() } });
      await m.mockEvent({ type: "resolved", payload: { note: "Reinstalled the driver.", byUserId: "a2" } });
      await m.mockEvent({ type: "user-confirmed", payload: { answer: "no", reason: "Still prints blank pages" } });
      await m.forceEventTimeout({ name: "resolved-2" });
    });
    const t = await createTicket(E, { requesterId: "e1", title: "Printer prints blank pages", description: "Every job comes out blank.", category: "hardware", priority: "LOW", source: "PORTAL" });
    await E.DB.prepare("UPDATE tickets SET status = 'RESOLVED' WHERE id = ?").bind(t.id).run();

    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "stale", round: 2 });
    const kinds = (await emailsFor(t.id)).map((e) => e.kind);
    expect(kinds).toEqual(["team_new", "employee_ack", "resolved_confirm", "reopened"]);
    expect((await ticketRow(t.number))?.status).toBe("NEW");
  });
});

describe("Triage agent", () => {
  it("writes one internal note with a least-loaded suggestion when the model is unavailable", async () => {
    const id = await bareTicket("INC-9001");
    await E.DB.prepare("UPDATE tickets SET assignee_id = 'a1', status = 'ASSIGNED' WHERE number = 'INC-9001'").run(); // a1 now has 1 open
    const target = await bareTicket("INC-9002");
    const stub = E.TRIAGE_AGENT.getByName("triage") as unknown as { triage(id: string): Promise<{ status: string; suggestedAssignee: { id: string } | null; summary: string }> };
    const r = await stub.triage(target);
    expect(r.status).toBe("fallback");
    expect(r.suggestedAssignee?.id).toBe("a3");
    const again = await stub.triage(target); // idempotent
    expect(again.summary).toBe(r.summary);
    const notes = await E.DB.prepare("SELECT body, visibility FROM ticket_comments WHERE ticket_id = ?").bind(target).all<{ body: string; visibility: string }>();
    expect(notes.results).toHaveLength(1);
    expect(notes.results[0]).toMatchObject({ visibility: "internal" });
    expect(notes.results[0]!.body).toContain("Net Agent Two");
    expect(id).toBeTruthy();
  });

  it("skips (and logs) once the daily budget is used up", async () => {
    const target = await bareTicket("INC-9003");
    const stub = E.TRIAGE_AGENT.getByName("triage-budget") as unknown as { triage(id: string): Promise<{ status: string }> };
    const prev = E.TRIAGE_DAILY_BUDGET;
    (E as { TRIAGE_DAILY_BUDGET?: string }).TRIAGE_DAILY_BUDGET = "0";
    try {
      // The DO reads its own env; emulate an exhausted budget by filling agent_runs instead.
      for (let i = 0; i < 150; i++) {
        await E.DB.prepare("INSERT INTO agent_runs (id, agent, route_method, status, created_at) VALUES (?, 'triage', 'workflow', 'completed', ?)").bind(crypto.randomUUID(), Date.now()).run();
      }
      expect((await stub.triage(target)).status).toBe("skipped");
    } finally {
      (E as { TRIAGE_DAILY_BUDGET?: string }).TRIAGE_DAILY_BUDGET = prev;
      await E.DB.prepare("DELETE FROM agent_runs WHERE ticket_id IS NULL").run();
    }
  });
});

describe("console actions", () => {
  it("assign → start (first response) → resolve, scoped to the agent's team", async () => {
    await bareTicket("INC-9101");
    expect((await call("/api/console/tickets/INC-9101/assign", post({}, hwAgent))).status).toBe(404);
    expect((await call("/api/console/tickets/INC-9101/assign", post({}, emp))).status).toBe(403);
    expect((await call("/api/console/tickets/INC-9101/assign", post({}, netAgent))).status).toBe(200);
    expect(await ticketRow("INC-9101")).toMatchObject({ status: "ASSIGNED", assignee_id: "a1", first_response_at: null });
    expect((await call("/api/console/tickets/INC-9101/status", post({ status: "IN_PROGRESS" }, netAgent))).status).toBe(200);
    expect((await ticketRow("INC-9101"))?.first_response_at).not.toBeNull();
    expect((await call("/api/console/tickets/INC-9101/resolve", post({ note: "Reset the AP" }, netAgent))).status).toBe(200);
    expect((await ticketRow("INC-9101"))?.status).toBe("RESOLVED");
    expect((await call("/api/console/tickets/INC-9101/resolve", post({ note: "again" }, netAgent))).status).toBe(409);
  });

  it("lets the requester confirm from the portal (closes without a workflow)", async () => {
    await bareTicket("INC-9102", "RESOLVED");
    expect((await call("/api/tickets/INC-9102/confirm", post({ answer: "yes" }, netAgent))).status).toBe(404);
    const res = await call("/api/tickets/INC-9102/confirm", post({ answer: "yes" }, emp));
    expect(await res.json()).toMatchObject({ result: "closed" });
    expect((await ticketRow("INC-9102"))?.status).toBe("CLOSED");
  });

  it("shows the Outbox to admins only", async () => {
    expect((await call("/api/console/outbox", { headers: { Cookie: netAgent } })).status).toBe(403);
  });
});

describe("signed confirm links", () => {
  it("verifies purpose, signature and expiry", async () => {
    const s = "secret-secret-secret-secret";
    const tok = await signLink(s, { purpose: "confirm", sub: "t1", exp: Date.now() + 60_000 });
    expect((await verifyLink(s, tok, "confirm"))?.sub).toBe("t1");
    expect(await verifyLink(s, tok, "approve")).toBeNull();
    expect(await verifyLink("other-secret-other-secret", tok, "confirm")).toBeNull();
    expect(await verifyLink(s, tok, "confirm", Date.now() + 120_000)).toBeNull();
    expect(await verifyLink(s, `${tok.split(".")[0]}.AAAA`, "confirm")).toBeNull();
  });

  it("GET only shows the question; POST records the answer", async () => {
    const id = await bareTicket("INC-9201", "RESOLVED");
    const tok = await signLink(E.BETTER_AUTH_SECRET, { purpose: "confirm", sub: id, exp: Date.now() + 86_400_000 });
    const page = await call(`/api/public/confirm?t=${encodeURIComponent(tok)}&a=no`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Reopen the ticket");
    expect((await ticketRow("INC-9201"))?.status).toBe("RESOLVED"); // a scanner opening the link changes nothing

    const form = new URLSearchParams({ t: tok, a: "yes" });
    const res = await call("/api/public/confirm", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    expect(await res.text()).toContain("closed the ticket");
    expect((await ticketRow("INC-9201"))?.status).toBe("CLOSED");
    expect((await call(`/api/public/confirm?t=bogus`)).status).toBe(410);
  });
});

describe("inbound email", () => {
  const raw = (from: string, to: string, subject: string, body: string) =>
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@mail.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

  function message(from: string, to: string, subject: string, body: string) {
    const text = raw(from, to, subject, body);
    const bytes = new TextEncoder().encode(text);
    return {
      from,
      to,
      raw: new Response(bytes).body!,
      rawSize: bytes.byteLength,
      headers: new Headers({ subject }),
      setReject: vi.fn(),
      forward: vi.fn(),
      reply: vi.fn(),
    } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
  }

  it("strips quoted history from replies", () => {
    expect(stripReply("Thanks, that worked!\n\nOn Mon, 3 Nov 2026, IT wrote:\n> Try restarting")).toBe("Thanks, that worked!");
    expect(stripReply("Still broken\n> old\n-- \nAnanya")).toBe("Still broken");
  });

  it("help@ creates a ticket for a known employee", async () => {
    await handleInboundEmail(message("e1@minocy.example", "help@minocy.example", "Outlook keeps asking for my password", "Since this morning Outlook prompts every 5 minutes."), E);
    const t = await E.DB.prepare("SELECT title, source, requester_id FROM tickets WHERE source = 'EMAIL'").first<{ title: string; source: string; requester_id: string }>();
    expect(t).toMatchObject({ title: "Outlook keeps asking for my password", requester_id: "e1" });
  });

  it("ticket+INC-…@ adds a comment; staff replies count as first response", async () => {
    const id = await bareTicket("INC-9301");
    await handleInboundEmail(message("e1@minocy.example", "ticket+inc-9301@minocy.example", "Re: [INC-9301] Bare ticket", "It happens on battery only.\n\nOn Tue, IT wrote:\n> hi"), E);
    await handleInboundEmail(message("a1@minocy.example", "ticket+INC-9301@minocy.example", "Re: [INC-9301]", "Thanks, checking now."), E);
    const comments = await E.DB.prepare("SELECT body, source FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at").bind(id).all<{ body: string; source: string }>();
    expect(comments.results).toEqual([
      { body: "It happens on battery only.", source: "email" },
      { body: "Thanks, checking now.", source: "email" },
    ]);
    expect((await ticketRow("INC-9301"))?.first_response_at).not.toBeNull();
  });

  it("rejects unknown senders and other people's tickets", async () => {
    const stranger = message("someone@evil.example", "help@minocy.example", "hi", "hello");
    await handleInboundEmail(stranger, E);
    expect(stranger.setReject).toHaveBeenCalledWith(expect.stringContaining("isn't registered"));
    await E.DB.prepare("INSERT INTO user (id, name, email, email_verified, role) VALUES ('e9', 'Other', 'e9@minocy.example', 1, 'employee')").run();
    const nosy = message("e9@minocy.example", "ticket+INC-9301@minocy.example", "Re", "let me in");
    await handleInboundEmail(nosy, E);
    expect(nosy.setReject).toHaveBeenCalled();
  });
});

describe("daily digest", () => {
  it("summarises the last 24 h and emails each admin", async () => {
    const s = await computeDigest(E);
    expect(s.newTickets).toBeGreaterThan(0);
    const r = await sendDailyDigest(E);
    expect(r.admins).toBe(1);
    const d = await E.DB.prepare("SELECT recipient FROM notifications WHERE kind = 'digest'").first<{ recipient: string }>();
    expect(d?.recipient).toBe("admin@minocy.example");
  });
});
