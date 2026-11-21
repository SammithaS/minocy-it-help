import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initialSupportState } from "../src/agents/state";
import type { SupportAgent } from "../src/agents/support-agent";
import type { AppEnv } from "../src/env";

const E = env as AppEnv;
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const json = (method: string, body: unknown, cookie: string): RequestInit => ({
  method,
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

const MINE = "11111111-1111-4111-8111-111111111111";
const UNTITLED = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";
const FOLLOW = "44444444-4444-4444-8444-444444444444";

let alice: string;

beforeAll(async () => {
  const now = Date.now();
  const stmts = [
    "DELETE FROM feedback", "DELETE FROM notifications", "DELETE FROM agent_runs", "DELETE FROM chat_sessions", "DELETE FROM session", "DELETE FROM verification",
    "DELETE FROM app_grants", "DELETE FROM access_requests", "DELETE FROM password_resets", "DELETE FROM directory_accounts", "DELETE FROM ticket_comments",
    "DELETE FROM ticket_events", "DELETE FROM tickets", "DELETE FROM team_members", "DELETE FROM devices", "DELETE FROM user",
    "INSERT INTO user (id, name, email, email_verified, role) VALUES ('al', 'Alice Rao', 'alice@minocy.example', 1, 'employee'), ('bo', 'Bob Das', 'bob@minocy.example', 1, 'employee')",
    `INSERT INTO chat_sessions (id, user_id, title, outcome, created_at, updated_at) VALUES
      ('${MINE}', 'al', 'Wi-Fi keeps dropping', 'resolved', ${now - 7200_000}, ${now - 3600_000}),
      ('${UNTITLED}', 'al', NULL, 'open', ${now}, ${now}),
      ('${THEIRS}', 'bo', 'Printer jam', 'escalated', ${now}, ${now}),
      ('${FOLLOW}', 'al', 'VPN timeout', 'resolved', ${now}, ${now})`,
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
  alice = await signIn("alice@minocy.example");
});

describe("chat history & feedback API", () => {
  it("lists only my titled conversations, newest first", async () => {
    const r = await call("/api/chats", { headers: { Cookie: alice } });
    const { chats } = (await r.json()) as { chats: { id: string; title: string; rating: string | null }[] };
    expect(chats.map((c) => c.id)).toEqual([FOLLOW, MINE]);
    expect((await call("/api/chats")).status).toBe(401);
  });

  it("stores one rating per chat, and changing your mind replaces it", async () => {
    expect((await call(`/api/chats/${MINE}/feedback`, json("PUT", { rating: "down", comment: "Took too many steps" }, alice))).status).toBe(200);
    expect((await call(`/api/chats/${MINE}/feedback`, json("PUT", { rating: "up" }, alice))).status).toBe(200);
    const rows = await E.DB.prepare("SELECT rating, comment FROM feedback WHERE session_id = ?").bind(MINE).all();
    expect(rows.results).toEqual([{ rating: "up", comment: null }]);
    const got = (await (await call(`/api/chats/${MINE}/feedback`, { headers: { Cookie: alice } })).json()) as { feedback: unknown };
    expect(got.feedback).toEqual({ rating: "up", comment: null });
    const list = (await (await call("/api/chats", { headers: { Cookie: alice } })).json()) as { chats: { id: string; rating: string | null }[] };
    expect(list.chats.find((c) => c.id === MINE)?.rating).toBe("up");
  });

  it("won't rate someone else's chat or accept junk", async () => {
    expect((await call(`/api/chats/${THEIRS}/feedback`, json("PUT", { rating: "down" }, alice))).status).toBe(404);
    expect((await call(`/api/chats/${MINE}/feedback`, json("PUT", { rating: "meh" }, alice))).status).toBe(400);
    expect((await call(`/api/chats/not-a-uuid/feedback`, json("PUT", { rating: "up" }, alice))).status).toBe(400);
  });
});

describe("24 h follow-up", () => {
  const stub = () => E.SUPPORT_AGENT.getByName(FOLLOW) as unknown as DurableObjectStub<SupportAgent>;
  type Internals = { syncFollowUp(a: { kind: string }): Promise<void> };

  it("schedules a check-in when the assistant fixes something, and cancels it on escalation", async () => {
    await runInDurableObject(stub(), async (agent: SupportAgent) => {
      agent.setState({ ...initialSupportState, articleTitle: "VPN connection timeout", resolvedByAssistant: true });
      await (agent as unknown as Internals).syncFollowUp({ kind: "resolved" });
      const f = agent.state.followUp!;
      expect(f).toMatchObject({ topic: "VPN connection timeout", sent: false });
      expect(f.dueAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
      expect(agent.getSchedules().map((s) => s.callback)).toEqual(["followUp"]);

      await (agent as unknown as Internals).syncFollowUp({ kind: "resolved" }); // no duplicate
      expect(agent.getSchedules()).toHaveLength(1);

      await (agent as unknown as Internals).syncFollowUp({ kind: "escalate" });
      expect(agent.state.followUp).toBeNull();
      expect(agent.getSchedules()).toHaveLength(0);
    });
  });

  it("posts the check-in to the chat and emails the employee, once", async () => {
    await runInDurableObject(stub(), async (agent: SupportAgent) => {
      agent.setState({
        ...initialSupportState,
        articleTitle: "VPN connection timeout",
        resolvedByAssistant: true,
        followUp: { scheduleId: "s1", topic: "VPN connection timeout", dueAt: Date.now(), sent: false },
      });
      await agent.followUp({ topic: "VPN connection timeout" });
      await agent.followUp({ topic: "VPN connection timeout" }); // already sent → no-op

      const followUps = agent.messages.filter((m) => m.parts.some((p) => p.type === "data-followup"));
      expect(followUps).toHaveLength(1);
      expect(followUps[0]!.parts.find((p) => p.type === "text")).toMatchObject({ text: expect.stringContaining("Is it still working?") });
      expect(agent.state.followUp?.sent).toBe(true);
    });
    const mails = await E.DB.prepare("SELECT recipient, subject FROM notifications WHERE kind = 'chat_followup'").all();
    expect(mails.results).toEqual([{ recipient: "alice@minocy.example", subject: "Is VPN connection timeout still working?" }]);
  });

  it("skips the check-in if a ticket was raised in the meantime", async () => {
    await runInDurableObject(stub(), async (agent: SupportAgent) => {
      const before = agent.messages.length;
      agent.setState({
        ...initialSupportState,
        resolvedByAssistant: true,
        ticketNumber: "INC-1001",
        followUp: { scheduleId: "s2", topic: "x", dueAt: Date.now(), sent: false },
      });
      await agent.followUp({ topic: "x" });
      expect(agent.messages.length).toBe(before);
    });
  });
});
