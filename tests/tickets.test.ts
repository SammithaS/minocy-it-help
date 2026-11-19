import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { createTicket } from "../src/lib/tickets";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const json = (body: unknown, cookie: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie },
  body: JSON.stringify(body),
});

async function signIn(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  await call("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  const otp = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`to=${email}`))?.match(/code is (\d{6})/)?.[1];
  log.mockRestore();
  const res = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, otp }),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let emp: string, other: string, netAgent: string, hwAgent: string;

beforeAll(async () => {
  const stmts = [
    "DELETE FROM ticket_comments", "DELETE FROM ticket_events", "DELETE FROM audit_log", "DELETE FROM tickets",
    "DELETE FROM team_members", "DELETE FROM routing_rules", "DELETE FROM sla_policies", "DELETE FROM teams",
    "DELETE FROM session", "DELETE FROM verification", "DELETE FROM user", "DELETE FROM counters",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-network', 'Network', 'net@x.example'), ('team-hardware', 'Hardware', 'hw@x.example')",
    "INSERT INTO routing_rules (category, team_id) VALUES ('network', 'team-network'), ('hardware', 'team-hardware')",
    "INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only) VALUES ('CRITICAL', 60, 0), ('HIGH', 240, 0), ('MEDIUM', 480, 0), ('LOW', 1080, 1)",
    "INSERT INTO user (id, name, email, email_verified, role) VALUES ('e1', 'Emp One', 'e1@minocy.example', 1, 'employee'), ('e2', 'Emp Two', 'e2@minocy.example', 1, 'employee'), ('a1', 'Net Agent', 'a1@minocy.example', 1, 'agent'), ('a2', 'HW Agent', 'a2@minocy.example', 1, 'agent')",
    "INSERT INTO team_members (team_id, user_id) VALUES ('team-network', 'a1'), ('team-hardware', 'a2')",
  ];
  await env.DB.batch(stmts.map((q) => env.DB.prepare(q)));
  emp = await signIn("e1@minocy.example");
  other = await signIn("e2@minocy.example");
  netAgent = await signIn("a1@minocy.example");
  hwAgent = await signIn("a2@minocy.example");
});

describe("createTicket", () => {
  it("numbers tickets, routes by category and sets the SLA", async () => {
    const now = new Date("2026-11-20T04:30:00Z"); // Fri 10:00 IST
    const a = await createTicket(env as AppEnv, {
      requesterId: "e1",
      title: "Wi-Fi drops every few minutes",
      description: "Disconnects on Minocy-Corp since this morning.",
      category: "network",
      priority: "HIGH",
      source: "CHAT",
      stepsTried: [{ order: 1, text: "Toggle Wi-Fi", result: "failed" }],
    }, now);
    const b = await createTicket(env as AppEnv, {
      requesterId: "e1",
      title: "Monitor says no signal",
      description: "Second screen stays black on the dock.",
      category: "hardware",
      priority: "LOW",
      source: "PORTAL",
    }, now);
    expect(a.number).toBe("INC-1001");
    expect(b.number).toBe("INC-1002");
    expect(a.team?.name).toBe("Network");
    expect(b.team?.name).toBe("Hardware");
    expect(a.slaDueAt - now.getTime()).toBe(4 * 3600_000);
    const row = await env.DB.prepare("SELECT status, steps_tried FROM tickets WHERE number = 'INC-1001'").first<{ status: string; steps_tried: string }>();
    expect(row?.status).toBe("NEW");
    expect(JSON.parse(row!.steps_tried)).toHaveLength(1);
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE type = 'created'").first<{ n: number }>();
    expect(ev?.n).toBe(2);
  });

  it("rejects invalid input", async () => {
    await expect(
      createTicket(env as AppEnv, { requesterId: "e1", title: "x", description: "short", category: "network", priority: "LOW", source: "CHAT" }),
    ).rejects.toThrow();
  });
});

describe("ticket API", () => {
  it("lets employees see only their own tickets", async () => {
    const mine = (await (await call("/api/tickets", { headers: { Cookie: emp } })).json()) as { tickets: { number: string }[] };
    expect(mine.tickets.map((t) => t.number).sort()).toEqual(["INC-1001", "INC-1002"]);
    const theirs = (await (await call("/api/tickets", { headers: { Cookie: other } })).json()) as { tickets: unknown[] };
    expect(theirs.tickets).toHaveLength(0);
    expect((await call("/api/tickets/INC-1001", { headers: { Cookie: other } })).status).toBe(404);
    expect((await call("/api/tickets/INC-1001", { headers: { Cookie: emp } })).status).toBe(200);
  });

  it("creates portal tickets", async () => {
    const res = await call("/api/tickets", json({ title: "Teams camera not working", description: "Black screen in every meeting today.", category: "network" }, emp));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: { number: string; priority: string } };
    expect(body.ticket.priority).toBe("MEDIUM");
    // Employees can't self-assign CRITICAL from the portal.
    const crit = await call("/api/tickets", json({ title: "Everything is down", description: "Nothing works at all today.", category: "network", priority: "CRITICAL" }, emp));
    expect(crit.status).toBe(400);
  });

  it("hides internal notes from the employee and records first response", async () => {
    expect((await call("/api/tickets/INC-1001/comments", json({ body: "Checking the AP logs", visibility: "internal" }, netAgent))).status).toBe(201);
    expect((await call("/api/tickets/INC-1001/comments", json({ body: "Can you tell me which floor?" }, netAgent))).status).toBe(201);
    // An employee asking for "internal" still posts publicly.
    expect((await call("/api/tickets/INC-1001/comments", json({ body: "3rd floor, near the lifts", visibility: "internal" }, emp))).status).toBe(201);

    const asEmp = (await (await call("/api/tickets/INC-1001", { headers: { Cookie: emp } })).json()) as { comments: { body: string; visibility: string }[]; ticket: { firstResponseAt: number | null } };
    expect(asEmp.comments.map((c) => c.body)).toEqual(["Can you tell me which floor?", "3rd floor, near the lifts"]);
    expect(asEmp.ticket.firstResponseAt).not.toBeNull();
    const asStaff = (await (await call("/api/tickets/INC-1001", { headers: { Cookie: netAgent } })).json()) as { comments: unknown[] };
    expect(asStaff.comments).toHaveLength(3);
    expect((await call("/api/tickets/INC-1001/comments", json({ body: "hi" }, other))).status).toBe(404);
  });

  it("only reopens resolved tickets, and only for the requester", async () => {
    expect((await call("/api/tickets/INC-1002/reopen", json({ reason: "still broken" }, emp))).status).toBe(409);
    await env.DB.prepare("UPDATE tickets SET status = 'RESOLVED', resolved_at = 1 WHERE number = 'INC-1002'").run();
    expect((await call("/api/tickets/INC-1002/reopen", json({ reason: "still broken" }, other))).status).toBe(404);
    const res = await call("/api/tickets/INC-1002/reopen", json({ reason: "still broken" }, emp));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("NEW");
  });
});

describe("console API", () => {
  it("is staff-only and scoped to the agent's teams", async () => {
    expect((await call("/api/console/tickets", { headers: { Cookie: emp } })).status).toBe(403);
    const net = (await (await call("/api/console/tickets", { headers: { Cookie: netAgent } })).json()) as { tickets: { team: { name: string } }[]; teams: { name: string }[] };
    expect(net.tickets.every((t) => t.team.name === "Network")).toBe(true);
    expect(net.tickets.length).toBeGreaterThan(0);
    expect(net.teams.map((t) => t.name)).toEqual(["Network"]);
    const hw = (await (await call("/api/console/tickets", { headers: { Cookie: hwAgent } })).json()) as { tickets: { number: string }[] };
    expect(hw.tickets.map((t) => t.number)).toEqual(["INC-1002"]);
  });

  it("refuses the live feed to employees and requires a WebSocket upgrade", async () => {
    expect((await call("/api/console/live", { headers: { Cookie: emp } })).status).toBe(403);
    expect((await call("/api/console/live", { headers: { Cookie: netAgent } })).status).toBe(426);
  });

  it("pushes new tickets to connected consoles", async () => {
    const res = await call("/api/console/live", { headers: { Cookie: netAgent, Upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const received: string[] = [];
    ws.accept();
    ws.addEventListener("message", (e) => received.push(String(e.data)));
    await createTicket(env as AppEnv, { requesterId: "e2", title: "VPN times out at home", description: "Secure Connect spins and fails.", category: "network", priority: "MEDIUM", source: "CHAT" });
    await vi.waitFor(() => expect(received.some((m) => m.includes("ticket.created") && m.includes("VPN times out"))).toBe(true));
    ws.close();
  });
});
