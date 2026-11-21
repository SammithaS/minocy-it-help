import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accessAction, afterToolAction, passwordAction, routeByRules } from "../src/agents/router";
import { initialSupportState, type SupportState } from "../src/agents/state";
import type { AppEnv } from "../src/env";
import {
  decideAccessRequest,
  extractJustification,
  isGenericRequest,
  loadCatalog,
  matchApplications,
  resolveAccessRequest,
  submitAccessRequest,
} from "../src/lib/access";
import { checkAccess, grantAccess, validateConnector } from "../src/lib/connectors";
import { mayRequestSignInCode, syncUserFromOkta } from "../src/lib/okta-users";
import { completePasswordReset, MAX_CODE_ATTEMPTS, startPasswordReset, verifyResetCode } from "../src/lib/password-reset";
import { signLink } from "../src/lib/tokens";

const E = env as AppEnv;
/** Okta is off in the shared test env (it gates sign-in); these tests pass their own. */
const OKTA: AppEnv = { ...E, OKTA_DOMAIN: "minocy-test.okta.com", OKTA_API_TOKEN: "test-okta-token" };
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
  body: new URLSearchParams(body).toString(),
});

// ───────────────────────────── fake GitHub / Atlassian / Okta ─────────────────────────────

const fake = {
  /** GitHub: username → membership state; absent = not a member. Users not in `ghUsers` don't exist. */
  ghUsers: new Set(["octo-dev", "new-hire", "flaky"]),
  ghMembers: new Map<string, "active" | "pending">([["octo-dev", "active"]]),
  /** After this many GET checks a pending invite becomes active. */
  acceptAfterChecks: 2,
  ghChecks: 0,
  /** Atlassian site users (email → accountId) and group members. */
  atlUsers: new Map<string, string>([["meera@minocy.example", "acc-meera"]]),
  atlGroups: new Map<string, Set<string>>([["jira-software-users", new Set()], ["confluence-users", new Set()]]),
  /** Okta users by email. */
  oktaUsers: new Map<string, { id: string; status: string; profile: Record<string, string | null> }>([
    ["rohan@minocy.example", { id: "00u-rohan", status: "LOCKED_OUT", profile: { login: "rohan@minocy.example", email: "rohan@minocy.example", firstName: "Rohan", lastName: "Das", department: "Sales", city: "Mumbai", managerId: "nikhil@minocy.example" } }],
    ["nikhil@minocy.example", { id: "00u-nikhil", status: "ACTIVE", profile: { login: "nikhil@minocy.example", email: "nikhil@minocy.example", firstName: "Nikhil", lastName: "Bose", department: "Sales", city: "Mumbai" } }],
    ["meera@minocy.example", { id: "00u-meera", status: "ACTIVE", profile: { login: "meera@minocy.example", email: "meera@minocy.example", firstName: "Meera", lastName: "Krishnan", department: "Design" } }],
    ["gone@minocy.example", { id: "00u-gone", status: "SUSPENDED", profile: { login: "gone@minocy.example", email: "gone@minocy.example", firstName: "Gone", lastName: "Person" } }],
  ]),
  oktaGroups: new Map<string, { name: string; members: Set<string> }>([["00gFIGMAUSERS0001", { name: "Figma Users", members: new Set() }]]),
  calls: [] as string[],
};

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  fake.calls.push(`${method} ${url.host}${url.pathname}`);
  const body = init?.body ? JSON.parse(String(init.body)) : null;

  if (url.host === "api.github.com") {
    let m = url.pathname.match(/^\/orgs\/minocy-labs\/memberships\/([^/]+)$/);
    if (m) {
      const user = decodeURIComponent(m[1]!);
      if (user === "flaky") return json(502, { message: "Bad gateway" });
      if (!fake.ghUsers.has(user)) return json(404, { message: "Not Found" });
      if (method === "PUT") {
        if (!fake.ghMembers.has(user)) fake.ghMembers.set(user, "pending");
        return json(200, { state: fake.ghMembers.get(user), role: "member" });
      }
      if (fake.ghMembers.get(user) === "pending" && ++fake.ghChecks >= fake.acceptAfterChecks) fake.ghMembers.set(user, "active");
      return fake.ghMembers.has(user) ? json(200, { state: fake.ghMembers.get(user) }) : json(404, { message: "Not Found" });
    }
    if ((m = url.pathname.match(/^\/users\/([^/]+)$/))) return fake.ghUsers.has(decodeURIComponent(m[1]!)) ? json(200, { login: m[1] }) : json(404, { message: "Not Found" });
    if (url.pathname === "/orgs/minocy-labs") return json(200, { login: "minocy-labs" });
    return json(404, { message: "Not Found" });
  }

  if (url.host === "minocy-test.atlassian.net") {
    if (url.pathname === "/rest/api/3/user/search") {
      const q = url.searchParams.get("query")!;
      const id = fake.atlUsers.get(q);
      return json(200, id ? [{ accountId: id, emailAddress: q, displayName: q, accountType: "atlassian" }] : []);
    }
    if (url.pathname === "/rest/api/3/user" && method === "POST") {
      const id = `acc-${fake.atlUsers.size + 1}`;
      fake.atlUsers.set(body.emailAddress, id);
      return json(201, { accountId: id, emailAddress: body.emailAddress, displayName: body.emailAddress, accountType: "atlassian" });
    }
    if (url.pathname === "/rest/api/3/group/user" && method === "POST") {
      const g = fake.atlGroups.get(url.searchParams.get("groupname")!);
      if (!g) return json(404, { errorMessages: ["Group not found"] });
      if (g.has(body.accountId)) return json(400, { errorMessages: ["Cannot add user. User is already a member of this group"] });
      g.add(body.accountId);
      return json(201, {});
    }
    if (url.pathname === "/rest/api/3/user/groups") {
      const id = url.searchParams.get("accountId")!;
      return json(200, [...fake.atlGroups].filter(([, s]) => s.has(id)).map(([name]) => ({ name })));
    }
    if (url.pathname === "/rest/api/3/groups/picker") {
      const q = url.searchParams.get("query")!;
      return json(200, { groups: fake.atlGroups.has(q) ? [{ name: q, groupId: `gid-${q}` }] : [] });
    }
    return json(404, { errorMessages: ["Not found"] });
  }

  if (url.host === "minocy-test.okta.com") {
    if (init?.headers && !String((init.headers as Record<string, string>).Authorization).startsWith("SSWS ")) return json(401, {});
    let m = url.pathname.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]!);
      const u = fake.oktaUsers.get(key) ?? [...fake.oktaUsers.values()].find((x) => x.id === key);
      return u ? json(200, u) : json(404, { errorCode: "E0000007" });
    }
    if ((m = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/lifecycle\/unlock$/))) {
      const u = [...fake.oktaUsers.values()].find((x) => x.id === m![1]);
      if (u) u.status = "ACTIVE";
      return json(200, {});
    }
    if (url.pathname.match(/^\/api\/v1\/users\/[^/]+\/lifecycle\/reset_password$/)) return json(200, {});
    if ((m = url.pathname.match(/^\/api\/v1\/groups\/([^/]+)\/users\/([^/]+)$/))) {
      const g = fake.oktaGroups.get(m[1]!);
      if (!g) return json(404, {});
      g.members.add(m[2]!);
      return new Response(null, { status: 204 });
    }
    if ((m = url.pathname.match(/^\/api\/v1\/groups\/([^/]+)$/))) {
      const g = fake.oktaGroups.get(m[1]!);
      return g ? json(200, { id: m[1], profile: { name: g.name } }) : json(404, {});
    }
    if ((m = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/groups$/))) {
      return json(200, [...fake.oktaGroups].filter(([, g]) => g.members.has(m![1]!)).map(([id, g]) => ({ id, profile: { name: g.name } })));
    }
    return json(404, {});
  }
  throw new Error(`Unexpected outbound fetch in tests: ${method} ${url}`);
}

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeAll(async () => {
  fetchSpy.mockImplementation(fakeFetch as typeof fetch);
  const stmts = [
    "DELETE FROM notifications", "DELETE FROM audit_log", "DELETE FROM app_grants", "DELETE FROM access_requests", "DELETE FROM applications",
    "DELETE FROM password_resets", "DELETE FROM agent_runs", "DELETE FROM ticket_comments", "DELETE FROM ticket_events",
    "DELETE FROM tickets", "DELETE FROM team_members", "DELETE FROM routing_rules", "DELETE FROM teams", "DELETE FROM session", "DELETE FROM devices",
    "DELETE FROM user", "DELETE FROM counters",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-software', 'Software', 'sw@team.example'), ('team-identity', 'Identity & Access', 'iam@team.example')",
    "INSERT INTO routing_rules (category, team_id) VALUES ('software', 'team-software'), ('identity', 'team-identity')",
    "INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only) VALUES ('MEDIUM', 480, 0) ON CONFLICT DO NOTHING",
    `INSERT INTO user (id, name, email, email_verified, role, department, manager_id) VALUES
      ('mgr', 'Lakshmi Pillai', 'lakshmi@minocy.example', 1, 'employee', 'Engineering', NULL),
      ('e1', 'Meera Krishnan', 'meera@minocy.example', 1, 'employee', 'Design', 'mgr'),
      ('e2', 'Rohan Das', 'rohan@minocy.example', 1, 'employee', 'Sales', NULL),
      ('adm', 'Kavya Rao', 'admin@minocy.example', 1, 'admin', 'IT', NULL)`,
    `INSERT INTO applications (id, name, description, owner_team_id, requires_manager_approval, aliases, connector, connector_config) VALUES
      ('app-figma', 'Figma', 'Design', 'team-software', 1, '["figjam"]', 'okta', '{"groupId":"00gFIGMAUSERS0001"}'),
      ('app-jira', 'Jira', 'Issues', 'team-software', 1, '[]', 'atlassian', '{"group":"jira-software-users","products":"jira-software"}'),
      ('app-sfdc', 'Salesforce', 'CRM', 'team-identity', 1, '["sfdc","crm"]', 'okta', '{"groupId":"00gSALESFORCE0001"}'),
      ('app-github', 'GitHub', 'Code', 'team-software', 1, '["gh"]', 'github', '{"org":"minocy-labs"}'),
      ('app-confluence', 'Confluence', 'Docs', 'team-software', 0, '["wiki"]', 'atlassian', '{"group":"confluence-users","products":"confluence"}'),
      ('app-legacy', 'Legacy CRM', 'Old', 'team-software', 1, '[]', NULL, '{}')`,
    "INSERT INTO app_grants (user_id, application_id) VALUES ('e1', 'app-jira')",
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
});
afterAll(() => fetchSpy.mockRestore());

const requestRow = (number: string) =>
  E.DB.prepare("SELECT id, status, approver_email, decision_note, provisioned_at, provision_detail, failure_ticket FROM access_requests WHERE number = ?").bind(number).first<{
    id: string;
    status: string;
    approver_email: string | null;
    decision_note: string | null;
    provisioned_at: number | null;
    provision_detail: string | null;
    failure_ticket: string | null;
  }>();
const kinds = async (to?: string) =>
  (await E.DB.prepare(`SELECT kind, recipient FROM notifications ${to ? "WHERE recipient = ?" : ""} ORDER BY created_at`).bind(...(to ? [to] : [])).all<{ kind: string; recipient: string }>()).results;
const hasGrant = async (user: string, app: string) => !!(await E.DB.prepare("SELECT 1 AS ok FROM app_grants WHERE user_id = ? AND application_id = ?").bind(user, app).first());

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
    expect(passwordAction({ ok: false, reason: "unavailable" })).toEqual({ kind: "password_blocked", reason: "unavailable" });

    const verified = { ...initialSupportState, passwordReset: { id: "r", stage: "verified" as const, maskedEmail: "m", accountLocked: false, expiresAt: 0 } };
    const codePart = { type: "tool-verifyResetCode", state: "output-available", output: { verified: true } };
    expect(afterToolAction(codePart, verified)).toEqual({ kind: "password_confirm" });
    // The client claiming "verified" isn't enough — the server's state decides.
    expect(afterToolAction(codePart, { ...verified, passwordReset: { ...verified.passwordReset, stage: "code_sent" } })?.kind).toBe("password_blocked");
    expect(afterToolAction({ type: "tool-resetPassword", state: "output-denied" }, verified)).toEqual({ kind: "password_cancelled" });
  });
});

describe("Access agent logic", () => {
  it("only offers apps that have a real connector", async () => {
    const catalog = await loadCatalog(E.DB);
    expect(catalog.map((a) => a.id)).not.toContain("app-legacy");
    expect((await loadCatalog(E.DB, { all: true })).map((a) => a.id)).toContain("app-legacy");
    expect(matchApplications("can I get SFDC please", catalog).map((a) => a.id)).toEqual(["app-sfdc"]);
    expect(matchApplications("figma and jira", catalog).map((a) => a.id).sort()).toEqual(["app-figma", "app-jira"]);
    expect(matchApplications("I need Legacy access", catalog)).toEqual([]);
  });

  it("only keeps a reason when there is one", async () => {
    const figma = (await loadCatalog(E.DB)).find((a) => a.id === "app-figma")!;
    expect(extractJustification("I need Figma access", figma)).toBe("");
    expect(extractJustification("I need Figma access to review the new website mock-ups", figma)).toContain("website");
  });

  it("resolves by rule without a model call, finds the manager, and asks GitHub apps for a username", async () => {
    const pick = vi.fn();
    const r = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need Figma access for the brand refresh designs"] }, pick);
    expect(pick).not.toHaveBeenCalled();
    expect(r).toMatchObject({ applicationId: "app-figma", method: "rules", alreadyHasAccess: false, approver: { name: "Lakshmi Pillai", kind: "manager" }, usernameLabel: null });
    expect(r.justification).toContain("brand refresh");
    const gh = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["need github access"] }, null);
    expect(gh).toMatchObject({ applicationId: "app-github", usernameLabel: "Your GitHub username" });
  });

  it("knows when the person already has the app", async () => {
    expect(await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need access to Jira"] }, null)).toMatchObject({ applicationName: "Jira", alreadyHasAccess: true });
  });

  it("asks which app without a model call when nothing is named, and uses the model only for ambiguity", async () => {
    const none = vi.fn();
    const r0 = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need access to an app"] }, none);
    expect(none).not.toHaveBeenCalled();
    expect(r0).toMatchObject({ applicationId: null, method: "none" });
    expect(r0.clarifyingQuestion).toMatch(/Figma/);
    expect(r0.clarifyingQuestion).not.toMatch(/Legacy/);
    expect(isGenericRequest("can I get access to the design tool")).toBe(false);

    const pick = vi.fn(async () => ({ applicationId: "app-figma", justification: "Designing the onboarding flow", clarifyingQuestion: null }));
    const r = await resolveAccessRequest(E, { requesterId: "e1", userMessages: ["I need figma and jira"] }, pick);
    expect(pick).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ applicationId: "app-figma", method: "llm", justification: "Designing the onboarding flow" });
  });

  it("falls back to the app's owner team when there's no manager on file", async () => {
    const r = await resolveAccessRequest(E, { requesterId: "e2", userMessages: ["need salesforce for the Q3 pipeline review"] }, null);
    expect(r.approver).toMatchObject({ kind: "owner_team", email: "iam@team.example" });
  });

  it("requires a valid GitHub username for GitHub apps", async () => {
    expect(await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-github", justification: "Working on the sales tooling repo" })).toEqual({ ok: false, error: "Add your github username." });
    expect(await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-github", justification: "Working on the sales tooling repo", externalUsername: "-bad--name" })).toEqual({
      ok: false,
      error: "That isn't a valid GitHub username.",
    });
    expect((await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-legacy", justification: "Need it for the old reports" })).ok).toBe(false);
  });
});

describe("connectors (against faked APIs)", () => {
  it("GitHub: member → active, new user → pending invite, unknown user → failed, outage → retryable error", async () => {
    const app = { name: "GitHub", connector: "github" as const, config: { org: "minocy-labs" } };
    const user = { email: "x@minocy.example", name: "X" };
    expect(await grantAccess(E, { app, user, externalUsername: "octo-dev" })).toMatchObject({ status: "active" });
    expect(await grantAccess(E, { app, user, externalUsername: "new-hire" })).toMatchObject({ status: "pending", detail: expect.stringContaining("waiting for them to accept") });
    expect(await grantAccess(E, { app, user, externalUsername: "ghost-user" })).toEqual({ status: "failed", detail: 'GitHub user "ghost-user" doesn\'t exist.' });
    await expect(grantAccess(E, { app, user, externalUsername: "flaky" })).rejects.toMatchObject({ retryable: true });
    await expect(grantAccess({ ...E, GITHUB_TOKEN: "" }, { app, user, externalUsername: "octo-dev" })).rejects.toMatchObject({ retryable: false });
    fake.ghMembers.delete("new-hire");
    fake.ghChecks = 0;
  });

  it("Atlassian: invites people who aren't on the site, then adds them to the group (idempotent)", async () => {
    const app = { name: "Jira", connector: "atlassian" as const, config: { group: "jira-software-users", products: "jira-software" } };
    const t = { app, user: { email: "newbie@minocy.example", name: "Newbie" }, externalUsername: null };
    expect(await grantAccess(E, t)).toEqual({ status: "active", detail: 'Invited to the Atlassian site and added to the group "jira-software-users".' });
    expect(await grantAccess(E, t)).toEqual({ status: "active", detail: 'Added to the group "jira-software-users".' });
    expect(await checkAccess(E, t)).toBe("active");
    expect(await grantAccess(E, { ...t, app: { ...app, config: { group: "nope-users" } } })).toMatchObject({ status: "failed" });
  });

  it("Okta: adds the person to the group; people missing from Okta fail clearly", async () => {
    const app = { name: "Figma", connector: "okta" as const, config: { groupId: "00gFIGMAUSERS0001" } };
    expect(await grantAccess(OKTA, { app, user: { email: "meera@minocy.example", name: "Meera" }, externalUsername: null })).toEqual({ status: "active", detail: 'Added to the Okta group "Figma Users".' });
    expect(await checkAccess(OKTA, { app, user: { email: "meera@minocy.example", name: "Meera" }, externalUsername: null })).toBe("active");
    expect(await grantAccess(OKTA, { app, user: { email: "stranger@minocy.example", name: "S" }, externalUsername: null })).toEqual({ status: "failed", detail: "stranger@minocy.example isn't a user in Okta." });
  });

  it("validates connector settings before saving", async () => {
    expect(await validateConnector(E, "github", { org: "minocy-labs" })).toBeNull();
    expect(await validateConnector(E, "github", { org: "not-ours" })).toMatch(/not found/);
    expect(await validateConnector(E, "atlassian", { group: "confluence-users", products: "confluence" })).toBeNull();
    expect(await validateConnector(E, "atlassian", { group: "confluence-users", products: "trello" })).toMatch(/Unknown product/);
    expect(await validateConnector(E, "okta", { groupId: "bad id" })).toMatch(/group id/);
  });
});

describe("AccessRequestWorkflow (real connectors, faked APIs)", () => {
  it("manager approves → added to the Okta group... via Atlassian here: invite + group → verified → emails", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "access-decision", payload: { decision: "approve", note: "Go for it" } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-jira", justification: "Track the CRM migration tasks" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "provisioned" });
    expect(await requestRow(r.number)).toMatchObject({ status: "PROVISIONED", decision_note: "Go for it", provision_detail: expect.stringContaining("jira-software-users") });
    expect(await hasGrant("e2", "app-jira")).toBe(true);
    expect((await kinds("rohan@minocy.example")).map((k) => k.kind)).toEqual(expect.arrayContaining(["access_submitted", "access_granted"]));
  });

  it("GitHub invite: waits for the person to accept, then grants", async () => {
    fake.acceptAfterChecks = 2;
    fake.ghChecks = 0;
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
      await m.mockEvent({ type: "access-decision", payload: { decision: "approve", note: null } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-github", justification: "Design system repo reviews", externalUsername: "new-hire" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "provisioned" });
    expect(await requestRow(r.number)).toMatchObject({ status: "PROVISIONED", provision_detail: expect.stringContaining("accepted") });
    expect((await kinds("meera@minocy.example")).map((k) => k.kind)).toEqual(expect.arrayContaining(["access_invite_pending", "access_granted"]));
    expect(fake.ghChecks).toBeGreaterThanOrEqual(2);
  });

  it("a connector failure raises a ticket for the app's team, and Retry provisions once fixed", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "access-decision", payload: { decision: "approve", note: null } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-github", justification: "Sales tooling repository work", externalUsername: "typo-user" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    const out = (await instance!.getOutput()) as { outcome: string; ticket: string };
    expect(out.outcome).toBe("failed");
    const row = await requestRow(r.number);
    expect(row).toMatchObject({ status: "FAILED", failure_ticket: out.ticket, provision_detail: 'GitHub user "typo-user" doesn\'t exist.' });
    const ticket = await E.DB.prepare("SELECT team_id, escalation_reason, description FROM tickets WHERE number = ?").bind(out.ticket).first<{ team_id: string; escalation_reason: string; description: string }>();
    expect(ticket).toMatchObject({ team_id: "team-software", escalation_reason: "provisioning_failed" });
    expect(ticket?.description).toContain("typo-user");
    expect((await kinds("rohan@minocy.example")).map((k) => k.kind)).toContain("access_failed");
    expect(await hasGrant("e2", "app-github")).toBe(false);
  });

  it("apps that need no approval provision straight away", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => m.disableRetryDelays());
    const r = await submitAccessRequest(E, { requesterId: "e2", applicationId: "app-confluence", justification: "Reading the sales playbook" });
    if (!r.ok) throw new Error(r.error);
    expect(r.approver).toBeNull();
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect((await requestRow(r.number))?.status).toBe("PROVISIONED");
  });

  it("tells the employee when the manager rejects, and expires unanswered requests", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockEvent({ type: "access-decision", payload: { decision: "reject", note: "Use the shared account" } });
    });
    const r = await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-sfdc", justification: "Customer research for redesign" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "rejected" });
    expect((await requestRow(r.number))?.status).toBe("REJECTED");
  });

  it("expires requests nobody answers", async () => {
    await using wf = await introspectWorkflow(E.ACCESS_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.forceEventTimeout({ name: "decision" });
    });
    const r = await submitAccessRequest(E, { requesterId: "e1", applicationId: "app-sfdc", justification: "Second try, for the redesign research" });
    if (!r.ok) throw new Error(r.error);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "expired" });
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
    expect(await (await call("/api/public/access", form({ t: token, a: "approve" }))).text()).toContain("already decided");
  });

  it("rejects forged, expired or wrong-purpose links", async () => {
    const confirmToken = await signLink(E.BETTER_AUTH_SECRET, { purpose: "confirm", sub: id, exp: Date.now() + 60_000 });
    expect((await call("/api/public/access", form({ t: confirmToken, a: "approve" }))).status).toBe(410);
    expect((await call("/api/public/access", form({ t: `${token}x`, a: "approve" }))).status).toBe(410);
    expect(await decideAccessRequest(E, "nope", "approve", null, { id: null, email: null })).toBe("not_found");
    expect(await status()).toBe("PENDING");
  });
});

describe("self-service password reset through Okta", () => {
  const codeFrom = (logs: string) => logs.match(/Your code is (\d{6})/)?.[1] ?? logs.match(/code: (\d{6})/)?.[1];

  it("code → verify → approve → Okta unlocks the account and emails its reset link", async () => {
    fake.calls = [];
    const { result: start, logs } = await captureLog(() => startPasswordReset(OKTA, { userId: "e2" }));
    if (!start.ok) throw new Error(start.reason);
    expect(start).toMatchObject({ accountLocked: true, maskedEmail: expect.stringMatching(/^r•+@minocy\.example$/) });
    const code = codeFrom(logs)!;
    const stored = await E.DB.prepare("SELECT html, text FROM notifications WHERE kind = 'password_code' ORDER BY created_at DESC LIMIT 1").first<{ html: string; text: string }>();
    expect(`${stored?.html}${stored?.text}`).not.toContain(code); // the Outbox never shows the code

    expect(await completePasswordReset(OKTA, { resetId: start.resetId, userId: "e2" })).toEqual({ ok: false, reason: "not_verified" });
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifyResetCode(OKTA, { resetId: start.resetId, userId: "e2", code: wrong })).toEqual({ ok: false, reason: "wrong", attemptsLeft: MAX_CODE_ATTEMPTS - 1 });
    expect(await verifyResetCode(OKTA, { resetId: start.resetId, userId: "e1", code })).toEqual({ ok: false, reason: "not_found" });
    expect(await verifyResetCode(OKTA, { resetId: start.resetId, userId: "e2", code })).toEqual({ ok: true });

    expect(await completePasswordReset(OKTA, { resetId: start.resetId, userId: "e2" })).toMatchObject({ ok: true, unlocked: true });
    expect(fake.calls).toEqual(expect.arrayContaining(["POST minocy-test.okta.com/api/v1/users/00u-rohan/lifecycle/unlock", "POST minocy-test.okta.com/api/v1/users/00u-rohan/lifecycle/reset_password"]));
    expect(await completePasswordReset(OKTA, { resetId: start.resetId, userId: "e2" })).toMatchObject({ ok: true, unlocked: false }); // idempotent
  });

  it("hands over to IT when Okta isn't connected, the person isn't in Okta, or is suspended", async () => {
    expect(await startPasswordReset(E, { userId: "e1" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await startPasswordReset(OKTA, { userId: "adm" })).toEqual({ ok: false, reason: "no_account" });
    await E.DB.prepare("INSERT INTO user (id, name, email, email_verified, role) VALUES ('gone', 'Gone Person', 'gone@minocy.example', 1, 'employee')").run();
    expect(await startPasswordReset(OKTA, { userId: "gone" })).toEqual({ ok: false, reason: "disabled" });
  });

  it("locks the attempt after too many wrong codes, and limits resets per day", async () => {
    const { result: start, logs } = await captureLog(() => startPasswordReset(OKTA, { userId: "e1" }));
    if (!start.ok) throw new Error(start.reason);
    const code = codeFrom(logs)!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) await verifyResetCode(OKTA, { resetId: start.resetId, userId: "e1", code: wrong });
    expect(await verifyResetCode(OKTA, { resetId: start.resetId, userId: "e1", code })).toEqual({ ok: false, reason: "too_many" });
    await captureLog(() => startPasswordReset(OKTA, { userId: "e1" }));
    await captureLog(() => startPasswordReset(OKTA, { userId: "e1" }));
    expect(await startPasswordReset(OKTA, { userId: "e1" })).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("people from Okta", () => {
  it("creates or refreshes the portal profile (with manager) from Okta", async () => {
    expect(await syncUserFromOkta(OKTA, "rohan@minocy.example")).toBe("synced");
    const rohan = await E.DB.prepare("SELECT u.name, u.department, u.location, u.okta_id, m.email AS manager FROM user u LEFT JOIN user m ON m.id = u.manager_id WHERE u.email = 'rohan@minocy.example'").first();
    expect(rohan).toEqual({ name: "Rohan Das", department: "Sales", location: "Mumbai", okta_id: "00u-rohan", manager: "nikhil@minocy.example" });
  });

  it("only lets active Okta users ask for a sign-in code (admins keep break-glass access)", async () => {
    expect(await mayRequestSignInCode(OKTA, "meera@minocy.example")).toBe(true);
    expect(await mayRequestSignInCode(OKTA, "stranger@minocy.example")).toBe(false);
    expect(await mayRequestSignInCode(OKTA, "gone@minocy.example")).toBe(false);
    expect(await mayRequestSignInCode(OKTA, "admin@minocy.example")).toBe(true);
    expect(await mayRequestSignInCode(E, "anyone@minocy.example")).toBe(true); // Okta not configured: portal users as before
  });
});
