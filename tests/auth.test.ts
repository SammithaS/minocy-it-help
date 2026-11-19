import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "http://localhost";

async function seedUser(id: string, email: string, role: "employee" | "agent" | "admin") {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, `Test ${role}`, email, role, now, now)
    .run();
}

function call(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

/** Requests an OTP (captured from the dev email log) and signs in; returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  const send = await call("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
  expect(send.status).toBe(200);
  const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`to=${email}`));
  log.mockRestore();
  const otp = line?.match(/code is (\d{6})/)?.[1];
  expect(otp).toBeDefined();

  const res = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, otp }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toContain("session_token");
  return cookie;
}

describe("api", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM session; DELETE FROM verification; DELETE FROM user;");
  });

  it("GET /api/health", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 401 from /api/me when signed out", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(401);
  });

  it("unknown API path is a JSON 404", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
  });

  it("signs an employee in with email OTP and returns their role", async () => {
    await seedUser("u1", "emp@minocy.example", "employee");
    const cookie = await signIn("emp@minocy.example");
    const res = await call("/api/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; email: string } };
    expect(body.user).toMatchObject({ role: "employee", email: "emp@minocy.example" });
  });

  it("returns agent role and team membership for IT agents", async () => {
    await seedUser("u2", "agent@minocy.example", "agent");
    await env.DB.prepare("INSERT INTO teams (id, name, mailbox) VALUES ('t1', 'Network', 'net@x.example')").run();
    await env.DB.prepare("INSERT INTO team_members (team_id, user_id) VALUES ('t1', 'u2')").run();
    const cookie = await signIn("agent@minocy.example");
    const res = await call("/api/me", { headers: { Cookie: cookie } });
    const body = (await res.json()) as { user: { role: string }; teams: { name: string }[] };
    expect(body.user.role).toBe("agent");
    expect(body.teams.map((t) => t.name)).toEqual(["Network"]);
    await env.DB.exec("DELETE FROM team_members; DELETE FROM teams;");
  });

  it("does not let unknown emails sign up", async () => {
    const res = await call("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ email: "stranger@evil.example", otp: "123456" }),
    });
    expect(res.ok).toBe(false);
    const { results } = await env.DB.prepare("SELECT id FROM user").all();
    expect(results).toHaveLength(0);
  });

  it("ignores attempts to set role through sign-in input", async () => {
    await seedUser("u3", "emp2@minocy.example", "employee");
    const cookie = await signIn("emp2@minocy.example");
    const update = await call("/api/auth/update-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(update.ok).toBe(false);
    const row = await env.DB.prepare("SELECT role FROM user WHERE id = 'u3'").first<{ role: string }>();
    expect(row?.role).toBe("employee");
  });
});
