import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GapDraft, KbGapAgent } from "../src/agents/kb-gap-agent";
import { computeAnalytics } from "../src/api/console-admin";
import type { AppEnv } from "../src/env";
import { articleStatements, contentHash, prepareArticle, validateArticle, type ArticleInput } from "../src/lib/kb-index";

const E = env as AppEnv;
const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const json = (method: string, body: unknown, cookie: string): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie },
  body: JSON.stringify(body),
});
const get = (path: string, cookie: string) => call(path, { headers: { Cookie: cookie } });

async function signIn(email: string): Promise<string> {
  const log = vi.spyOn(console, "log");
  await call("/api/auth/email-otp/send-verification-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, type: "sign-in" }) });
  const otp = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(`to=${email}`))?.match(/code is (\d{6})/)?.[1];
  log.mockRestore();
  const res = await call("/api/auth/sign-in/email-otp", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ email, otp }) });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const BODY = (title: string, extraStep = "") => `# ${title}

Use this when Teams can't find your headset.

## Symptoms

- Others can't hear you
- The headset isn't in the device list

## Quick fixes

1. Unplug the headset and plug it into another USB port.
2. In Teams, open Settings → Devices and pick the headset.${extraStep ? `\n3. ${extraStep}` : ""}

## Advanced steps

1. Update the headset firmware from {{software_centre}}.

## Escalate when

- The headset isn't detected on any port`;

const META = {
  id: "KB-050",
  title: "Teams can't find my headset",
  category: "Collaboration",
  tags: ["teams", "headset", "microphone"],
  os: ["windows" as const],
  ticket_category: "collaboration" as const,
  priority: "MEDIUM" as const,
  action: "troubleshoot" as const,
};

let admin: string, agent: string, emp: string;

beforeAll(async () => {
  const now = Date.now();
  const stmts = [
    "DELETE FROM kb_proposals", "DELETE FROM kb_revisions", "DELETE FROM kb_fts", "DELETE FROM kb_steps", "DELETE FROM kb_articles",
    "DELETE FROM feedback", "DELETE FROM notifications", "DELETE FROM agent_runs", "DELETE FROM chat_sessions", "DELETE FROM session", "DELETE FROM verification",
    "DELETE FROM app_grants", "DELETE FROM access_requests", "DELETE FROM password_resets", "DELETE FROM ticket_comments",
    "DELETE FROM ticket_events", "DELETE FROM tickets", "DELETE FROM team_members", "DELETE FROM routing_rules", "DELETE FROM sla_policies", "DELETE FROM teams",
    "DELETE FROM devices", "DELETE FROM user",
    "INSERT INTO teams (id, name, mailbox) VALUES ('team-collab', 'Collaboration', 'col@team.example'), ('team-network', 'Network', 'net@team.example')",
    "INSERT INTO routing_rules (category, team_id) VALUES ('collaboration', 'team-collab'), ('network', 'team-network')",
    "INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only) VALUES ('MEDIUM', 480, 0), ('HIGH', 240, 0)",
    `INSERT INTO user (id, name, email, email_verified, role) VALUES ('adm', 'Admin', 'admin@minocy.example', 1, 'admin'),
      ('ag', 'Collab Agent', 'ag@minocy.example', 1, 'agent'), ('ag2', 'Net Agent', 'ag2@minocy.example', 1, 'agent'), ('e1', 'Emp One', 'e1@minocy.example', 1, 'employee')`,
    "INSERT INTO team_members (team_id, user_id) VALUES ('team-collab', 'ag'), ('team-network', 'ag2')",
    `INSERT INTO tickets (id, number, requester_id, team_id, assignee_id, title, description, category, priority, status, source, steps_tried, sla_due_at, sla_breached, resolved_at, escalation_reason, kb_article_id, created_at, updated_at) VALUES
      ('t1', 'INC-2001', 'e1', 'team-collab', NULL, 'Headset not detected in Teams', 'Nobody can hear me on calls.', 'collaboration', 'HIGH', 'NEW', 'CHAT', '[]', ${now - 60_000}, 0, NULL, 'all_steps_tried', 'KB-050', ${now - 3_600_000}, ${now}),
      ('t2', 'INC-2002', 'e1', 'team-collab', 'ag', 'Outlook calendar not syncing', 'Meetings missing.', 'collaboration', 'MEDIUM', 'IN_PROGRESS', 'PORTAL', '[]', ${now + 3_600_000}, 0, NULL, 'portal', NULL, ${now - 7_200_000}, ${now}),
      ('t3', 'INC-2003', 'e1', 'team-network', NULL, 'VPN drops', 'Every hour.', 'network', 'MEDIUM', 'RESOLVED', 'CHAT', '[]', ${now - 1000}, 0, ${now - 5000}, 'user_requested', NULL, ${now - 9_000_000}, ${now}),
      ('t4', 'INC-2004', 'e1', 'team-network', NULL, 'Wi-Fi slow', 'Slow.', 'network', 'LOW', 'RESOLVED', 'EMAIL', '[]', ${now - 100_000}, 1, ${now - 1000}, 'email', NULL, ${now - 9_000_000}, ${now})`,
    `INSERT INTO chat_sessions (id, user_id, title, outcome, created_at, updated_at) VALUES
      ('c1', 'e1', 'wifi', 'resolved', ${now}, ${now}), ('c2', 'e1', 'vpn', 'resolved', ${now}, ${now}), ('c3', 'e1', 'headset', 'escalated', ${now}, ${now}), ('c4', 'e1', NULL, 'open', ${now}, ${now})`,
    "INSERT INTO feedback (id, session_id, user_id, rating) VALUES ('f1', 'c1', 'e1', 'up'), ('f2', 'c2', 'e1', 'up'), ('f3', 'c3', 'e1', 'down')",
    `INSERT INTO agent_runs (id, session_id, agent, route_method, reason, status, duration_ms, created_at) VALUES
      ('r1', 'c1', 'knowledge', 'rules', 'new problem', 'completed', 400, ${now}), ('r2', 'c2', 'knowledge', 'llm', 'model chose guides', 'completed', 2000, ${now}),
      ('r3', 'c3', 'ticket', 'rules', 'asked', 'error', 100, ${now}), ('r4', 'c3', 'ticket', 'llm', 'model fallback', 'fallback', NULL, ${now}),
      ('r5', NULL, 'triage', 'workflow', 'daily budget reached', 'skipped', 5, ${now})`,
  ];
  await E.DB.batch(stmts.map((q) => E.DB.prepare(q)));
  // KB-050 exists as a file-managed article.
  const p = prepareArticle(META, BODY(META.title));
  await E.DB.batch(articleStatements(E.DB, p, await contentHash(p.meta, p.body), "file"));
  admin = await signIn("admin@minocy.example");
  agent = await signIn("ag@minocy.example");
  emp = await signIn("e1@minocy.example");
});

describe("KB validation & indexing", () => {
  const input = (body: string, over: Partial<ArticleInput> = {}): ArticleInput => ({ ...META, body, ...over });
  it("accepts a well-formed guide and rejects broken ones", () => {
    expect(validateArticle(input(BODY(META.title))).ok).toBe(true);
    expect(validateArticle(input(BODY("Another title")))).toMatchObject({ ok: false, error: expect.stringContaining("must match the title") });
    expect(validateArticle(input(BODY(META.title).replace("## Symptoms", "## Signs")))).toMatchObject({ ok: false, error: expect.stringContaining("sections must be") });
    expect(validateArticle(input(BODY(META.title).replace("{{software_centre}}", "{{nope}}")))).toMatchObject({ ok: false, error: expect.stringContaining("{{nope}}") });
  });
  it("writes the article, its steps and FTS rows with placeholders filled", async () => {
    const steps = await E.DB.prepare("SELECT section, text FROM kb_steps WHERE article_id = 'KB-050' ORDER BY section DESC, \"order\"").all<{ text: string }>();
    expect(steps.results.length).toBe(3);
    expect(steps.results.at(-1)?.text).toContain("Minocy Software Centre");
    const fts = await E.DB.prepare("SELECT COUNT(*) AS n FROM kb_fts WHERE article_id = 'KB-050'").first<{ n: number }>();
    expect(fts?.n).toBe(4);
  });
});

describe("KB editor → KbReindexWorkflow", () => {
  it("saves a revision, embeds, upserts and makes it live (console-managed)", async () => {
    await using wf = await introspectWorkflow(E.KB_REINDEX_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "embed" }, [0, 1, 2, 3].map(() => new Array(768).fill(0.01)));
      await m.mockStepResult({ name: "vectorize" }, "upserted");
    });
    const body = BODY(META.title, "Restart Teams completely (right-click the tray icon → Quit).");
    expect((await call("/api/console/kb/KB-050", json("PUT", { ...META, body }, agent))).status).toBe(403);
    const r = await call("/api/console/kb/KB-050", json("PUT", { ...META, body }, admin));
    expect(r.status).toBe(200);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "live" });

    const a = await E.DB.prepare("SELECT managed_by FROM kb_articles WHERE id = 'KB-050'").first<{ managed_by: string }>();
    expect(a?.managed_by).toBe("console");
    const steps = await E.DB.prepare("SELECT COUNT(*) AS n FROM kb_steps WHERE article_id = 'KB-050'").first<{ n: number }>();
    expect(steps?.n).toBe(4);
    const detail = (await (await get("/api/console/kb/KB-050", admin)).json()) as { article: { body: string }; revisions: { status: string }[] };
    expect(detail.article.body).toContain("{{software_centre}}"); // editor gets the raw revision back
    expect(detail.revisions[0]?.status).toBe("live");
  });

  it("refuses an invalid article without starting anything", async () => {
    const r = await call("/api/console/kb/KB-050", json("PUT", { ...META, body: BODY("Wrong title") }, admin));
    expect(r.status).toBe(400);
  });

  it("marks the revision failed when indexing keeps failing, leaving the live article alone", async () => {
    await using wf = await introspectWorkflow(E.KB_REINDEX_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "embed" }, new Error("Workers AI down"), 5);
    });
    await call("/api/console/kb/KB-050", json("PUT", { ...META, body: BODY(META.title, "Something new") }, admin));
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ outcome: "failed" });
    const rev = await E.DB.prepare("SELECT status, error FROM kb_revisions WHERE article_id = 'KB-050' ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string }>();
    expect(rev).toMatchObject({ status: "failed", error: expect.stringContaining("Workers AI down") });
    const steps = await E.DB.prepare("SELECT COUNT(*) AS n FROM kb_steps WHERE article_id = 'KB-050'").first<{ n: number }>();
    expect(steps?.n).toBe(4);
  });
});

describe("Knowledge-gap agent", () => {
  const stub = () => E.KB_GAP_AGENT.getByName("kb-gap") as unknown as DurableObjectStub<KbGapAgent>;
  const withDraft = (d: GapDraft | Error) =>
    runInDurableObject(stub(), (a: KbGapAgent) => {
      (a as unknown as { draft: () => Promise<GapDraft> }).draft = async () => {
        if (d instanceof Error) throw d;
        return d;
      };
    });

  it("skips notes too short to learn from, without a model call", async () => {
    expect(await stub().review("t2", "Fixed.")).toMatchObject({ status: "skipped", reason: expect.stringContaining("too short") });
  });

  it("proposes an update to the guide that was followed, validated", async () => {
    await withDraft({
      action: "update",
      rationale: "Teams kept the old device until it was fully quit.",
      title: null,
      body: BODY("whatever the model wrote", "Quit Teams from the tray icon and open it again."),
      tags: null,
    });
    const r = await stub().review("t1", "Teams had cached the old headset; fully quitting Teams from the tray fixed it.");
    expect(r.status).toBe("proposed");
    const p = await E.DB.prepare("SELECT article_id, kind, title, body FROM kb_proposals WHERE id = ?").bind(r.proposalId).first<{ article_id: string; kind: string; title: string; body: string }>();
    expect(p).toMatchObject({ article_id: "KB-050", kind: "update", title: META.title });
    expect(p?.body.startsWith(`# ${META.title}`)).toBe(true);
    // Idempotent per ticket.
    expect((await stub().review("t1", "Teams had cached the old headset; fully quitting Teams fixed it.")).proposalId).toBe(r.proposalId);
  });

  it("drops a draft that doesn't follow the guide format, and survives a model outage", async () => {
    await withDraft({ action: "new", rationale: "x", title: "VPN drops hourly", body: "# VPN drops hourly\n\nJust restart.", tags: ["vpn", "drops", "hourly"] });
    expect(await stub().review("t3", "Updated the VPN client to 5.2, which fixed the hourly disconnects for this user.")).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("didn't validate"),
    });
    await withDraft(new Error("429 quota"));
    expect(await stub().review("t4", "Moved the user to the 5 GHz band and the Wi-Fi speed came back to normal.")).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("model unavailable"),
    });
  });
});

describe("proposals queue", () => {
  it("lets an admin approve (→ revision → re-index) exactly once, or reject", async () => {
    const list = (await (await get("/api/console/kb-proposals", admin)).json()) as { proposals: { id: string; ticket_number: string }[] };
    expect(list.proposals).toHaveLength(1);
    const id = list.proposals[0]!.id;
    expect(list.proposals[0]!.ticket_number).toBe("INC-2001");
    const detail = (await (await get(`/api/console/kb-proposals/${id}`, admin)).json()) as { currentBody: string; proposal: { body: string } };
    expect(detail.currentBody).toContain("Restart Teams completely"); // live article, for the diff
    expect((await get("/api/console/kb-proposals", agent)).status).toBe(403);

    await using wf = await introspectWorkflow(E.KB_REINDEX_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "embed" }, [0, 1, 2, 3].map(() => new Array(768).fill(0.02)));
      await m.mockStepResult({ name: "vectorize" }, "upserted");
    });
    expect((await call(`/api/console/kb-proposals/${id}/approve`, json("POST", {}, admin))).status).toBe(200);
    expect((await call(`/api/console/kb-proposals/${id}/approve`, json("POST", {}, admin))).status).toBe(409);
    expect((await call(`/api/console/kb-proposals/${id}/reject`, json("POST", {}, admin))).status).toBe(409);
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    const body = await E.DB.prepare("SELECT body FROM kb_articles WHERE id = 'KB-050'").first<{ body: string }>();
    expect(body?.body).toContain("Quit Teams from the tray icon");
    const prop = await E.DB.prepare("SELECT status, revision_id FROM kb_proposals WHERE id = ?").bind(id).first<{ status: string; revision_id: string }>();
    expect(prop?.status).toBe("approved");
    expect(prop?.revision_id).toBeTruthy();
  });
});

describe("console queue, assignees, settings", () => {
  const queue = async (q: string, cookie = admin) =>
    ((await (await get(`/api/console/tickets?${q}`, cookie)).json()) as { tickets: { number: string }[] }).tickets.map((t) => t.number).sort();

  it("filters by priority, assignment, SLA and search", async () => {
    expect(await queue("scope=all&status=all&priority=HIGH")).toEqual(["INC-2001"]);
    expect(await queue("scope=all&assigned=unassigned")).toEqual(["INC-2001"]);
    expect(await queue("scope=all&sla=overdue")).toEqual(["INC-2001"]);
    expect(await queue("scope=all&sla=soon")).toEqual(["INC-2002"]);
    expect(await queue("scope=all&status=all&q=vpn")).toEqual(["INC-2003"]);
    expect(await queue("scope=all&status=RESOLVED")).toEqual(["INC-2003", "INC-2004"]);
    expect(await queue("assigned=me", agent)).toEqual(["INC-2002"]);
  });

  it("only offers (and accepts) the ticket's team members and admins as assignees", async () => {
    const a = (await (await get("/api/console/tickets/INC-2001/assignees", agent)).json()) as { assignees: { id: string }[] };
    expect(a.assignees.map((x) => x.id).sort()).toEqual(["adm", "ag"]);
    expect((await call("/api/console/tickets/INC-2001/assign", json("POST", { assigneeId: "ag2" }, admin))).status).toBe(400);
    expect((await call("/api/console/tickets/INC-2001/assign", json("POST", { assigneeId: "ag" }, admin))).status).toBe(200);
  });

  it("returns no transcript for a ticket without a chat, and hides other teams' tickets", async () => {
    expect(await (await get("/api/console/tickets/INC-2002/transcript", agent)).json()).toEqual({ transcript: null });
    expect((await get("/api/console/tickets/INC-2003/transcript", agent)).status).toBe(404);
  });

  it("lets admins change routing and SLA, validated", async () => {
    const s = (await (await get("/api/console/settings", admin)).json()) as { routing: unknown[]; sla: unknown[] };
    expect(s.routing).toHaveLength(2);
    expect((await get("/api/console/settings", agent)).status).toBe(403);
    expect((await call("/api/console/settings", json("PUT", { routing: [{ category: "network", teamId: "nope" }], sla: [] }, admin))).status).toBe(400);
    const ok = await call(
      "/api/console/settings",
      json("PUT", { routing: [{ category: "network", teamId: "team-collab" }], sla: [{ priority: "HIGH", minutes: 120, workingHoursOnly: false }] }, admin),
    );
    expect(ok.status).toBe(200);
    expect(await E.DB.prepare("SELECT team_id FROM routing_rules WHERE category = 'network'").first()).toEqual({ team_id: "team-collab" });
    expect(await E.DB.prepare("SELECT resolve_minutes FROM sla_policies WHERE priority = 'HIGH'").first()).toEqual({ resolve_minutes: 120 });
  });
});

describe("analytics", () => {
  it("computes resolution rate, per-agent stats, escalation reasons, SLA and CSAT", async () => {
    const a = await computeAnalytics(E.DB, 30);
    expect(a.chats).toEqual({ total: 3, resolved: 2, escalated: 1, resolutionRate: 2 / 3 });
    const knowledge = a.agents.find((x) => x.agent === "knowledge")!;
    expect(knowledge).toMatchObject({ runs: 2, completed: 2, viaRules: 1, viaLlm: 1, avgMs: 1200, p95Ms: 2000, fallbacks: 0 });
    expect(a.agents.find((x) => x.agent === "ticket")).toMatchObject({ runs: 1, errors: 1, fallbacks: 1 });
    expect(a.agents.find((x) => x.agent === "triage")).toMatchObject({ skipped: 1 });
    expect(a.escalationReasons.map((r) => r.reason).sort()).toEqual(["all_steps_tried", "email", "portal", "user_requested"]);
    // INC-2003 resolved before its due time; INC-2004 breached.
    expect(a.sla).toMatchObject({ resolved: 2, met: 1, metRate: 0.5 });
    expect(a.feedback).toEqual({ up: 2, down: 1, rate: 2 / 3 });
    expect(a.routing.find((r) => r.agent === "knowledge" && r.method === "rules")?.n).toBe(1);
  });

  it("is open to IT staff only", async () => {
    expect((await get("/api/console/analytics?days=7", agent)).status).toBe(200);
    expect((await get("/api/console/analytics", emp)).status).toBe(403);
  });
});
