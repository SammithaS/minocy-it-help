import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accessAction, afterToolAction, passwordAction, routeByRules } from "../src/agents/router";
import { initialSupportState, type SupportState } from "../src/agents/state";
import type { AppEnv } from "../src/env";
import {
  decideAccessRequest,
  extractJustification,
  loadCatalog,
  matchApplications,
  resolveAccessRequest,
  submitAccessRequest,
} from "../src/lib/access";
import {
  completePasswordReset,
  MAX_CODE_ATTEMPTS,
  passwordProblem,
  startPasswordReset,
  verifyResetCode,
} from "../src/lib/password-reset";
import { signLink } from "../src/lib/tokens";

const E = env as AppEnv;
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
  body: new URLSearchParams(body).toString(),
});

beforeAll(async () => {
  const stmts = [
    "DELETE FROM notifications", "DELETE FROM audit_log", "DELETE FROM app_grants", "DELETE FROM access_requests", "DELETE FROM applications",
    "DELETE FROM password_resets", "DELETE FROM directory_accounts", "DELETE FROM agent_runs", "DELETE FROM ticket_comments", "DELETE FROM ticket_events",
    "DELETE FROM tickets", "DELETE FROM team_members", "DELETE FROM routing_rules", "DELETE FROM teams", "DELETE FROM session", "DELETE FROM devices",
    "DELETE FROM user", "DELETE FROM counters",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-software', 'Software', 'sw@team.example'), ('team-identity', 'Identity & Access', 'iam@team.example')",
    `INSERT INTO user (id, name, email, email_verified, role, department, manager_id) VALUES
      ('mgr', 'Lakshmi Pillai', 'lakshmi@minocy.example', 1, 'employee', 'Engineering', NULL),
      ('e1', 'Meera Krishnan', 'meera@minocy.example', 1, 'employee', 'Design', 'mgr'),
      ('e2', 'Rohan Das', 'rohan@minocy.example', 1, 'employee', 'Sales', NULL),
      ('adm', 'Kavya Rao', 'admin@minocy.example', 1, 'admin', 'IT', NULL)`,
    `INSERT INTO applications (id, name, description, owner_team_id, requires_manager_approval, aliases) VALUES
      ('app-figma', 'Figma', 'Design', 'team-software', 1, '["figjam"]'),
      ('app-jira', 'Jira', 'Issues', 'team-software', 1, '[]'),
      ('app-sfdc', 'Salesforce', 'CRM', 'team-identity', 1, '["sfdc","crm"]'),
      ('app-wiki', 'Wiki', 'Docs', 'team-software', 0, '[]')`,
    "INSERT INTO app_grants (user_id, application_id) VALUES ('e1', 'app-jira')",
    `INSERT INTO directory_accounts (user_id, username, status) VALUES ('e1', 'meera', 'active'), ('e2', 'rohan.das', 'locked'), ('mgr', 'lakshmi', 'disabled')`,
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
});

const requestRow = (number: string) =>
  E.DB.prepare("SELECT id, status, approver_email, decision_note, provisioned_at FROM access_requests WHERE number = ?").bind(number).first<{
    id: string;
    status: string;
    approver_email: string | null;
    decision_note: string | null;
    provisioned_at: number | null;
  }>();
const kinds = async (to?: string) =>
  (await E.DB.prepare(`SELECT kind, recipient FROM notifications ${to ? "WHERE recipient = ?" : ""} ORDER BY created_at`).bind(...(to ? [to] : [])).all<{ kind: string; recipient: string }>()).results;

/** Sensitive emails print their text to the console in log mode — that's how dev (and tests) get the code. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const spy = vi.spyOn(console, "log");
  try {
    const result = await fn();
    return { result, logs: spy.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("routing", () => {
  const r = (t: string, s: SupportState = initialSupportState) => routeByRules(t, s)?.agent ?? null;
  it("routes tiles and plain asks straight to the right flow", () => {
    expect(r("I need to reset my password")).toBe("password");
    expect(r("I need access to an app")).toBe("access");
    expect(r("I need Figma access")).toBe("access");
    expect(r("what's happening with REQ-1004")).toBe("status");
    expect(r("any update on my requests")).toBe("status");
  });
  it("treats the next message as the app name after the Access agent asked", () => {
    expect(r("Figma", { ...initialSupportState, awaitingAccessApp: true })).toBe("access");
    expect(r("Figma")).toBeNull();
    expect(r("thanks", { ...initialSupportState, awaitingAccessApp: true })).toBe("chat");
  });

  it("maps agent results and card answers to actions", () => {
    expect(accessAction({ applicationName: null, alreadyHasAccess: false, openRequest: null, clarifyingQuestion: "Which app?" }).kind).toBe("access_info");
    expect(accessAction({ applicationName: "Figma", alreadyHasAccess: false, openRequest: null, clarifyingQuestion: null })).toEqual({ kind: "access_submit" });
    expect(accessAction(null)).toEqual({ kind: "redirect", to: "access" });
    expect(passwordAction({ ok: false, reason: "rate_limited" })).toEqual({ kind: "password_blocked", reason: "rate_limited" });

    const verified = { ...initialSupportState, passwordReset: { id: "r", stage: "verified" as const, maskedEmail: "m", accountLocked: false, expiresAt: 0 } };
    const codePart = { type: "tool-verifyResetCode", state: "output-available", output: { verified: true } };
    expect(afterToolAction(codePart, verified)).toEqual({ kind: "password_confirm" });
    // The client claiming "verified" isn't enough — the server's state decides.
    expect(afterToolAction(codePart, { ...verified, passwordReset: { ...verified.passwordReset, stage: "code_sent" } })?.kind).toBe("password_blocked");
    expect(afterToolAction({ type: "tool-resetPassword", state: "output-denied" }, verified)).toEqual({ kind: "password_cancelled" });
    expect(afterToolAction({ type: "tool-submitAccessRequest", state: "output-available", output: { number: "REQ-1001", application: "Figma", approver: "L" } }, initialSupportState)?.kind).toBe(
      "access_done",
    );
  });
});

describe("Access agent logic", () => {
  it("matches catalog apps by name and alias, as whole words", async () => {
    const catalog = await loadCatalog(E.DB);
    expect(matchApplications("can I get SFDC please", catalog).map((a) => a.id)).toEqual(["app-sfdc"]);
    expect(matchApplications("figma and jira", catalog).map((a) => a.id).sort()).toEqual(["app-figma", "app-jira"]);
    expect(matchApplications("I need a wikipedia login", catalog)).toEqual([]);
  });

  it("only keeps a reason when there is one", async () => {
    const figma = (await loadCatalog(E.DB)).find((a) => a.id === "app-figma")!;
    expect(extractJustification("I need Figma access", figma)).toBe("");
    expect(extractJustification("I need Figma access to review the new website mock-ups", figma)).toContain("website");
  });

  it("resolves by rule without a model call, and finds the manager", async () => {
    const pick = vi.fn();
    const r = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need Figma access for the brand refresh designs"] }, pick);
    expect(pick).not.toHaveBeenCalled();
    expect(r).toMatchObject({ applicationId: "app-figma", method: "rules", alreadyHasAccess: false, approver: { name: "Lakshmi Pillai", kind: "manager" } });
    expect(r.justification).toContain("brand refresh");
  });

  it("knows when the person already has the app", async () => {
    const r = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need access to Jira"] }, null);
    expect(r).toMatchObject({ applicationName: "Jira", alreadyHasAccess: true });
  });

  it("asks which app when nothing matches, and uses the model only for ambiguity", async () => {
    const none = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need access to an app"] }, null);
    expect(none.applicationId).toBeNull();
    expect(none.clarifyingQuestion).toMatch(/Figma/);

    const pick = vi.fn(async () => ({ applicationId: "app-figma", justification: "Designing the onboarding flow", clarifyingQuestion: null }));
    const r = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need figma and jira"] }, pick);
    expect(pick).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ applicationId: "app-figma", method: "llm", justification: "Designing the onboarding flow" });
  });

  it("falls back to the app's owner team when there's no manager on file", async () => {
    const r = await resolveAccessRequest(E, { requesterId: "e2", userMessages: ["need salesforce for the Q3 pipeline review"] }, null);
    expect(r.approver).toMatchObject({ kind: "owner_team", email: "iam@team.example" });
  });
});

describe("AccessRequestWorkflow", () => {
  it("emails the manager, provisions on approval and tells the employee", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "access-decision", payload: { decision: "approve", note: "Go for it" } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-figma", justification: "Brand refresh design reviews", sessionId: null });
    expect(r).toMatchObject({ ok: true, number: "REQ-1001", status: "PENDING" });

    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "provisioned" });

    const row = await requestRow("REQ-1001");
    expect(row).toMatchObject({ status: "PROVISIONED", approver_email: "lakshmi@minocy.example", decision_note: "Go for it" });
    expect(row?.provisioned_at).toBeTruthy();
    expect(await E.DB.prepare("SELECT 1 AS ok FROM app_grants WHERE user_id = 'e1' AND application_id = 'app-figma'").first()).toBeTruthy();
    expect((await kinds()).map((k) => `${k.kind}→${k.recipient}`)).toEqual([
      "access_approval→lakshmi@minocy.example",
      "access_submitted→meera@minocy.example",
      "access_granted→meera@minocy.example",
      "access_provisioned→sw@team.example",
    ]);
  });

  it("won't duplicate: already granted, or an open request returns the existing number", async () => {
    expect(await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-figma", justification: "Again please, for reviews" })).toEqual({ ok: false, error: "You already have Figma." });
    expect((await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-sfdc", justification: "short" })).ok).toBe(false);
  });

  it("tells the employee when the manager rejects", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "access-decision", payload: { decision: "reject", note: "Use the shared account" } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-sfdc", justification: "Q3 pipeline review with the team" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "rejected" });
    expect((await requestRow(r.number))?.status).toBe("REJECTED");
    expect((await kinds("rohan@minocy.example")).map((k) => k.kind)).toContain("access_rejected");
  });

  it("expires requests nobody answers", async () => {
    await using wf2 = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf2.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.forceEventTimeout({ name: "decision" });
    });
    const r2 = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-sfdc", justification: "Second try, the shared account is gone" });
    if (!r2.ok) throw new Error(r2.error);
    const [i2] = await wf2.get();
    await i2!.waitForStatus("complete");
    expect(await i2!.getOutput()).toEqual({ outcome: "expired" });
    expect((await requestRow(r2.number))?.status).toBe("EXPIRED");
  });

  it("provisions straight away when the app needs no approval", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => m.disableRetryDelays());
    const r = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-wiki", justification: "Reading the sales playbook" });
    if (!r.ok) throw new Error(r.error);
    expect(r.approver).toBeNull();
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect((await requestRow(r.number))?.status).toBe("PROVISIONED");
  });
});

describe("manager approval page", () => {
  let id: string;
  let token: string;
  beforeEach(async () => {
    id = crypto.randomUUID();
    await E.DB.prepare(
      "INSERT INTO access_requests (id, number, requester_id, application_id, justification, status, approver_id, approver_email) VALUES (?, ?, 'e1', 'app-sfdc', 'Customer research', 'PENDING', 'mgr', 'lakshmi@minocy.example')",
    )
      .bind(id, `REQ-9${Math.floor(Math.random() * 1e5)}`)
      .run();
    token = await signLink(E.BETTER_AUTH_SECRET, { purpose: "access-decision", sub: id, exp: Date.now() + 60_000 });
  });
  const status = async () => (await E.DB.prepare("SELECT status FROM access_requests WHERE id = ?").bind(id).first<{ status: string }>())?.status;

  it("GET only shows the request; POST decides once", async () => {
    const page = await call(`/api/public/access?t=${encodeURIComponent(token)}&a=approve`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Customer research");
    expect(await status()).toBe("PENDING");

    expect((await call("/api/public/access", form({ t: token, a: "reject", note: "Not this quarter" }))).status).toBe(200);
    expect(await status()).toBe("REJECTED");
    const again = await call("/api/public/access", form({ t: token, a: "approve" }));
    expect(await again.text()).toContain("already decided");
    expect(await status()).toBe("REJECTED");
  });

  it("rejects forged, expired or wrong-purpose links", async () => {
    const confirmToken = await signLink(E.BETTER_AUTH_SECRET, { purpose: "confirm", sub: id, exp: Date.now() + 60_000 });
    expect((await call("/api/public/access", form({ t: confirmToken, a: "approve" }))).status).toBe(410);
    expect((await call("/api/public/access", form({ t: `${token}x`, a: "approve" }))).status).toBe(410);
    expect(await decideAccessRequest(E, "nope", "approve", null, { id: null, email: null })).toBe("not_found");
    expect(await status()).toBe("PENDING");
  });
});

describe("self-service password reset", () => {
  const codeFrom = (logs: string) => logs.match(/Your code is (\d{6})/)?.[1] ?? logs.match(/code: (\d{6})/)?.[1];

  it("code → verify → approve → unlock → one-time link → new password", async () => {
    const { result: start, logs } = await captureLog(() => startPasswordReset(E, { userId: "e2" }));
    if (!start.ok) throw new Error(start.reason);
    expect(start).toMatchObject({ accountLocked: true, maskedEmail: expect.stringMatching(/^r•+@minocy\.example$/) });
    const code = codeFrom(logs)!;
    expect(code).toMatch(/^\d{6}$/);

    // The Outbox never shows the code.
    const stored = await E.DB.prepare("SELECT html, text FROM notifications WHERE kind = 'password_code' ORDER BY created_at DESC LIMIT 1").first<{ html: string; text: string }>();
    expect(`${stored?.html}${stored?.text}`).not.toContain(code);

    expect(await completePasswordReset(E, { resetId: start.resetId, userId: "e2" })).toEqual({ ok: false, reason: "not_verified" });
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifyResetCode(E, { resetId: start.resetId, userId: "e2", code: wrong })).toEqual({ ok: false, reason: "wrong", attemptsLeft: MAX_CODE_ATTEMPTS - 1 });
    expect(await verifyResetCode(E, { resetId: start.resetId, userId: "e1", code })).toEqual({ ok: false, reason: "not_found" }); // someone else's reset
    expect(await verifyResetCode(E, { resetId: start.resetId, userId: "e2", code })).toEqual({ ok: true });

    const { result: done, logs: linkLogs } = await captureLog(() => completePasswordReset(E, { resetId: start.resetId, userId: "e2" }));
    expect(done).toMatchObject({ ok: true, unlocked: true });
    const acct = await E.DB.prepare("SELECT status, must_change_password FROM directory_accounts WHERE user_id = 'e2'").first<{ status: string; must_change_password: number }>();
    expect(acct).toEqual({ status: "active", must_change_password: 1 });
    expect(await completePasswordReset(E, { resetId: start.resetId, userId: "e2" })).toMatchObject({ ok: true, unlocked: false }); // idempotent

    const t = decodeURIComponent(linkLogs.match(/password\?t=([^\s)&]+)/)![1]!);
    expect((await call(`/api/public/password?t=${encodeURIComponent(t)}`)).status).toBe(200);
    const weak = await call("/api/public/password", form({ t, password: "short", confirm: "short" }));
    expect(weak.status).toBe(400);
    const ok = await call("/api/public/password", form({ t, password: "Blue-Kettle-Rain-42", confirm: "Blue-Kettle-Rain-42" }));
    expect(ok.status).toBe(200);
    const after = await E.DB.prepare("SELECT must_change_password, password_changed_at FROM directory_accounts WHERE user_id = 'e2'").first<{ must_change_password: number; password_changed_at: number | null }>();
    expect(after?.must_change_password).toBe(0);
    expect(after?.password_changed_at).toBeTruthy();
    expect((await call("/api/public/password", form({ t, password: "Another-Good-Pass-7", confirm: "Another-Good-Pass-7" }))).status).toBe(410);
    expect((await kinds("rohan@minocy.example")).map((k) => k.kind)).toContain("password_changed");
  });

  it("locks the attempt after too many wrong codes, and limits resets per day", async () => {
    const { result: start, logs } = await captureLog(() => startPasswordReset(E, { userId: "e1" }));
    if (!start.ok) throw new Error(start.reason);
    const code = codeFrom(logs)!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) await verifyResetCode(E, { resetId: start.resetId, userId: "e1", code: wrong });
    expect(await verifyResetCode(E, { resetId: start.resetId, userId: "e1", code })).toEqual({ ok: false, reason: "too_many" });

    await captureLog(() => startPasswordReset(E, { userId: "e1" }));
    await captureLog(() => startPasswordReset(E, { userId: "e1" }));
    expect(await startPasswordReset(E, { userId: "e1" })).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("expires codes and refuses disabled or unknown accounts", async () => {
    const { result: start, logs } = await captureLog(() => startPasswordReset(E, { userId: "e2" }, Date.now() - 11 * 60_000));
    if (!start.ok) throw new Error(start.reason);
    expect(await verifyResetCode(E, { resetId: start.resetId, userId: "e2", code: codeFrom(logs)! })).toEqual({ ok: false, reason: "expired" });
    expect(await startPasswordReset(E, { userId: "mgr" })).toEqual({ ok: false, reason: "disabled" });
    expect(await startPasswordReset(E, { userId: "adm" })).toEqual({ ok: false, reason: "no_account" });
  });

  it("enforces the password policy", () => {
    expect(passwordProblem("Blue-Kettle-Rain-42", "rohan.das")).toBeNull();
    expect(passwordProblem("alllowercaseletters", "x")).toMatch(/three/);
    expect(passwordProblem("RohanDas-2026!", "rohan.das")).toMatch(/username/);
    expect(passwordProblem("Password-2026!", "x")).toMatch(/guess/);
  });
});
