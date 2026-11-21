import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";

const E = env as AppEnv;
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));

async function signIn(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  await call("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, type: "sign-in" }) });
  const otp = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`to=${email}`))?.match(/code is (\d{6})/)?.[1];
  log.mockRestore();
  const res = await call("/api/auth/sign-in/email-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, otp }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

let id = 0;
/** One JSON-RPC call to /mcp (Streamable HTTP). Parses JSON or a single SSE `data:` event. */
async function rpc(token: string | null, method: string, params: unknown = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      // Real HTTP requests always carry Host; the handler rejects ones without it (DNS-rebinding guard).
      Host: "localhost",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const raw = await res.text();
  const body = raw.trim().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}");
  return { status: res.status, body: JSON.parse(body) as { result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } } };
}
const toolJson = (r: Awaited<ReturnType<typeof rpc>>) => JSON.parse(r.body.result!.content![0]!.text) as Record<string, unknown>;

let agentCookie: string, empCookie: string, token: string;

beforeAll(async () => {
  const now = Date.now();
  const stmts = [
    "DELETE FROM api_tokens", "DELETE FROM kb_proposals", "DELETE FROM notifications", "DELETE FROM agent_runs", "DELETE FROM feedback", "DELETE FROM chat_sessions",
    "DELETE FROM session", "DELETE FROM verification", "DELETE FROM app_grants", "DELETE FROM access_requests", "DELETE FROM password_resets",
    "DELETE FROM audit_log", "DELETE FROM ticket_comments", "DELETE FROM ticket_events", "DELETE FROM tickets", "DELETE FROM team_members", "DELETE FROM teams",
    "DELETE FROM devices", "DELETE FROM user",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-hw', 'Hardware', 'hw@x.example'), ('team-net', 'Network', 'net@x.example')",
    `INSERT INTO user (id, name, email, email_verified, role) VALUES ('hw', 'Priya Nair', 'priya@minocy.example', 1, 'agent'), ('emp', 'Emp', 'emp@minocy.example', 1, 'employee')`,
    "INSERT INTO team_members (team_id, user_id) VALUES ('team-hw', 'hw')",
    `INSERT INTO tickets (id, number, requester_id, team_id, title, description, category, priority, status, source, steps_tried, sla_due_at, created_at, updated_at) VALUES
      ('t1', 'INC-3001', 'emp', 'team-hw', 'Battery swelling', 'The laptop case is bulging.', 'hardware', 'CRITICAL', 'NEW', 'CHAT', '[{"order":1,"text":"Stop using it","result":"worked"}]', ${now - 60_000}, ${now}, ${now}),
      ('t2', 'INC-3002', 'emp', 'team-hw', 'Dock not detected', 'Monitors stay black.', 'hardware', 'LOW', 'RESOLVED', 'PORTAL', '[]', ${now + 86_400_000}, ${now}, ${now}),
      ('t3', 'INC-3003', 'emp', 'team-net', 'VPN drops', 'Hourly.', 'network', 'MEDIUM', 'NEW', 'PORTAL', '[]', ${now + 3_600_000}, ${now}, ${now})`,
    "INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES ('c1', 't1', NULL, 'Triage agent: Likely cause: battery failure.', 'internal', 'system', " + now + ")",
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
  agentCookie = await signIn("priya@minocy.example");
  empCookie = await signIn("emp@minocy.example");
});

describe("personal access tokens", () => {
  it("lets IT staff create a token (shown once, stored hashed) and refuses employees", async () => {
    expect((await call("/api/console/tokens", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, Cookie: empCookie }, body: '{"name":"x"}' })).status).toBe(403);
    const r = await call("/api/console/tokens", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, Cookie: agentCookie }, body: JSON.stringify({ name: "Claude Code" }) });
    expect(r.status).toBe(201);
    token = ((await r.json()) as { token: string }).token;
    expect(token).toMatch(/^mit_[A-Za-z0-9_-]{40,}$/);
    const row = await E.DB.prepare("SELECT token_hash, prefix FROM api_tokens").first<{ token_hash: string; prefix: string }>();
    expect(row?.token_hash).not.toContain(token.slice(4, 20));
    expect(row?.prefix).toBe(token.slice(0, 8));
    const list = (await (await call("/api/console/tokens", { headers: { Cookie: agentCookie } })).json()) as { tokens: unknown[] };
    expect(JSON.stringify(list)).not.toContain(token);
  });
});

describe("IT Ops MCP server", () => {
  it("rejects requests without a valid token", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("mit_not-a-real-token-at-all-000000", "tools/list")).status).toBe(401);
  });

  it("initializes and lists the three tools", async () => {
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    expect((init.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("minocy-itops");
    const list = await rpc(token, "tools/list");
    expect(list.body.result!.tools!.map((t) => t.name).sort()).toEqual(["addInternalNote", "getTicket", "listMyTeamTickets"]);
  });

  it("lists only the caller's team tickets, open by default", async () => {
    const r = toolJson(await rpc(token, "tools/call", { name: "listMyTeamTickets", arguments: {} }));
    expect((r.tickets as { number: string; overdue: boolean }[]).map((t) => t.number)).toEqual(["INC-3001"]);
    expect((r.tickets as { overdue: boolean }[])[0]!.overdue).toBe(true);
    const all = toolJson(await rpc(token, "tools/call", { name: "listMyTeamTickets", arguments: { status: "all" } }));
    expect((all.tickets as { number: string }[]).map((t) => t.number).sort()).toEqual(["INC-3001", "INC-3002"]);
  });

  it("returns a ticket with steps tried and the triage note, but not other teams' tickets", async () => {
    const t = toolJson(await rpc(token, "tools/call", { name: "getTicket", arguments: { number: "inc3001" } }));
    expect(t).toMatchObject({ number: "INC-3001", priority: "CRITICAL", stepsTried: [{ text: "Stop using it" }] });
    expect((t.comments as { by: string; body: string }[])[0]).toMatchObject({ by: "Triage agent", body: expect.stringContaining("battery") });
    const other = await rpc(token, "tools/call", { name: "getTicket", arguments: { number: "INC-3003" } });
    expect(other.body.result!.isError).toBe(true);
  });

  it("adds an internal note as the token's owner, and revoking the token cuts access", async () => {
    const r = await rpc(token, "tools/call", { name: "addInternalNote", arguments: { number: "INC-3001", note: "Ordered a replacement battery." } });
    expect(r.body.result!.content![0]!.text).toContain("INC-3001");
    const c = await E.DB.prepare("SELECT author_id, visibility, source FROM ticket_comments WHERE body = 'Ordered a replacement battery.'").first();
    expect(c).toEqual({ author_id: "hw", visibility: "internal", source: "mcp" });
    expect((await rpc(token, "tools/call", { name: "addInternalNote", arguments: { number: "INC-3003", note: "nope" } })).body.result!.isError).toBe(true);

    const { id: tokenId } = (await E.DB.prepare("SELECT id FROM api_tokens").first<{ id: string }>())!;
    expect((await call(`/api/console/tokens/${tokenId}`, { method: "DELETE", headers: { Origin: BASE, Cookie: agentCookie } })).status).toBe(200);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });
});
