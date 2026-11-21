/**
 * Access requests: the app catalog, "does this person already have it?", submitting a request
 * (REQ-1001), the manager's decision and mock provisioning. Shared by the Access agent, the
 * supervisor's tools, the public approval page and AccessRequestWorkflow.
 */
import { z } from "zod";
import type { AccessStatus } from "../db/schema";
import type { AppEnv } from "../env";

export interface CatalogApp {
  id: string;
  name: string;
  description: string | null;
  ownerTeamId: string | null;
  ownerTeam: string | null;
  ownerMailbox: string | null;
  requiresManagerApproval: boolean;
  aliases: string[];
}

export interface Approver {
  id: string | null;
  name: string;
  email: string;
  /** "manager" = the requester's line manager; "owner_team" = no manager on file, the app's team decides. */
  kind: "manager" | "owner_team" | "admin";
}

export interface AccessRequestRow {
  id: string;
  number: string;
  requester_id: string;
  application_id: string;
  justification: string;
  status: AccessStatus;
  approver_id: string | null;
  approver_email: string | null;
  session_id: string | null;
  decision_note: string | null;
  decided_at: number | null;
  provisioned_at: number | null;
  workflow_instance_id: string | null;
  created_at: number;
  updated_at: number;
}

export const justificationSchema = z.string().trim().min(10, "Say in a few words why you need it (at least 10 characters).").max(1000);

export async function loadCatalog(db: D1Database): Promise<CatalogApp[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.description, a.owner_team_id, a.requires_manager_approval, a.aliases, t.name AS team, t.mailbox
       FROM applications a LEFT JOIN teams t ON t.id = a.owner_team_id ORDER BY a.name`,
    )
    .all<{ id: string; name: string; description: string | null; owner_team_id: string | null; requires_manager_approval: number; aliases: string; team: string | null; mailbox: string | null }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    ownerTeamId: r.owner_team_id,
    ownerTeam: r.team,
    ownerMailbox: r.mailbox,
    requiresManagerApproval: !!r.requires_manager_approval,
    aliases: safeJsonArray(r.aliases),
  }));
}

const safeJsonArray = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Catalog apps named in the text (by name or alias, whole words, case-insensitive). */
export function matchApplications(text: string, catalog: CatalogApp[]): CatalogApp[] {
  const t = text.toLowerCase();
  return catalog.filter((a) =>
    [a.name, ...a.aliases].some((term) => term.trim().length >= 2 && new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}($|[^a-z0-9])`).test(t)),
  );
}

/** The person who approves this user's access: their manager, else the app's owner team, else an IT admin. */
export async function findApprover(env: AppEnv, userId: string, app: CatalogApp): Promise<Approver | null> {
  if (!app.requiresManagerApproval) return null;
  const mgr = await env.DB.prepare("SELECT m.id, m.name, m.email FROM user u JOIN user m ON m.id = u.manager_id WHERE u.id = ? AND m.id != u.id")
    .bind(userId)
    .first<{ id: string; name: string; email: string }>();
  if (mgr) return { ...mgr, kind: "manager" };
  if (app.ownerMailbox) return { id: null, name: `${app.ownerTeam ?? "IT"} team`, email: app.ownerMailbox, kind: "owner_team" };
  const admin = env.IT_ADMIN_EMAIL
    ? { id: null, name: "IT admin", email: env.IT_ADMIN_EMAIL }
    : await env.DB.prepare("SELECT id, name, email FROM user WHERE role = 'admin' ORDER BY created_at LIMIT 1").first<{ id: string; name: string; email: string }>();
  return admin ? { ...admin, kind: "admin" } : null;
}

export interface AccessCheck {
  alreadyHasAccess: boolean;
  /** An open request for the same app (PENDING / APPROVED waiting for provisioning). */
  openRequest: { number: string; status: AccessStatus } | null;
  approver: Approver | null;
}

export async function checkAccess(env: AppEnv, userId: string, app: CatalogApp): Promise<AccessCheck> {
  const [grant, open, approver] = await Promise.all([
    env.DB.prepare("SELECT 1 AS ok FROM app_grants WHERE user_id = ? AND application_id = ?").bind(userId, app.id).first<{ ok: number }>(),
    env.DB.prepare("SELECT number, status FROM access_requests WHERE requester_id = ? AND application_id = ? AND status IN ('PENDING','APPROVED') ORDER BY created_at DESC LIMIT 1")
      .bind(userId, app.id)
      .first<{ number: string; status: AccessStatus }>(),
    findApprover(env, userId, app),
  ]);
  return { alreadyHasAccess: !!grant, openRequest: open ?? null, approver };
}

// ─────────────────────────── resolving a chat request ───────────────────────────

export interface ResolveAccessInput {
  requesterId: string;
  /** The employee's recent messages, oldest first; the latest is the request. */
  userMessages: string[];
}

export interface AccessResolution {
  applicationId: string | null;
  applicationName: string | null;
  /** The employee's reason, if they gave one (the approval card asks otherwise). */
  justification: string;
  alreadyHasAccess: boolean;
  openRequest: { number: string; status: AccessStatus } | null;
  approver: { name: string; email: string; kind: Approver["kind"] } | null;
  requiresApproval: boolean;
  ownerTeam: string | null;
  clarifyingQuestion: string | null;
  catalog: string[];
  method: "rules" | "llm" | "none";
}

/** What the model returns when the rules can't name exactly one app. */
export interface AccessPick {
  applicationId: string | null;
  justification: string | null;
  clarifyingQuestion: string | null;
}
export type AccessPicker = (args: { messages: string[]; catalog: CatalogApp[] }) => Promise<AccessPick>;

const REQUEST_PHRASE =
  /\b(hi|hello|hey|please|pls|kindly|can i|could i|can you|could you|i('d| would)? like|i (need|want)|i'?m requesting|requesting|request|get|give me|grant( me)?|need|want|access|permissions?|licen[cs]e|to|for|the|an?|account|app|me|on|in)\b/gi;

/** A reason is anything beyond "I need access to X". */
export function extractJustification(text: string, app: CatalogApp): string {
  const names = [app.name, ...app.aliases].map((n) => new RegExp(escapeRe(n), "gi"));
  let rest = text;
  for (const re of names) rest = rest.replace(re, " ");
  const meaningful = rest.replace(REQUEST_PHRASE, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return meaningful.split(/\s+/).filter(Boolean).length >= 3 ? text.trim().slice(0, 1000) : "";
}

export async function resolveAccessRequest(env: AppEnv, input: ResolveAccessInput, pick: AccessPicker | null): Promise<AccessResolution> {
  const catalog = await loadCatalog(env.DB);
  const names = catalog.map((a) => a.name);
  const latest = input.userMessages.at(-1) ?? "";
  const none = (question: string, method: AccessResolution["method"] = "none"): AccessResolution => ({
    applicationId: null,
    applicationName: null,
    justification: "",
    alreadyHasAccess: false,
    openRequest: null,
    approver: null,
    requiresApproval: false,
    ownerTeam: null,
    clarifyingQuestion: question,
    catalog: names,
    method,
  });

  // Rules first: the latest message, then the conversation, naming exactly one catalog app.
  let app: CatalogApp | null = null;
  let justification = "";
  let method: AccessResolution["method"] = "rules";
  const inLatest = matchApplications(latest, catalog);
  const inAll = inLatest.length ? inLatest : matchApplications(input.userMessages.slice(-6).join("\n"), catalog);
  if (inAll.length === 1) {
    app = inAll[0]!;
    justification = extractJustification(latest, app) || input.userMessages.slice(-6, -1).map((m) => extractJustification(m, app!)).find(Boolean) || "";
  } else if (pick) {
    method = "llm";
    try {
      const p = await pick({ messages: input.userMessages.slice(-6), catalog: inAll.length > 1 ? inAll : catalog });
      app = catalog.find((a) => a.id === p.applicationId) ?? null;
      if (!app) return none(p.clarifyingQuestion || `Which app do you need? I can request ${names.join(", ")}.`, "llm");
      justification = p.justification?.trim() ?? "";
    } catch (e) {
      console.warn("[access] picker failed:", e instanceof Error ? e.message : e);
      app = null;
    }
  }
  if (!app) {
    const choices = inAll.length > 1 ? inAll.map((a) => a.name) : names;
    return none(`Which app do you need access to? I can request ${choices.join(", ")}.`);
  }

  const check = await checkAccess(env, input.requesterId, app);
  return {
    applicationId: app.id,
    applicationName: app.name,
    justification: justificationSchema.safeParse(justification).success ? justification : "",
    alreadyHasAccess: check.alreadyHasAccess,
    openRequest: check.openRequest,
    approver: check.approver ? { name: check.approver.name, email: check.approver.email, kind: check.approver.kind } : null,
    requiresApproval: app.requiresManagerApproval,
    ownerTeam: app.ownerTeam,
    clarifyingQuestion: null,
    catalog: names,
    method,
  };
}

// ─────────────────────────── submit / decide / provision ───────────────────────────

async function nextAccessNumber(db: D1Database): Promise<string> {
  await db.prepare("INSERT INTO counters (name, value) VALUES ('access', 1000) ON CONFLICT(name) DO NOTHING").run();
  const row = await db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'access' RETURNING value").first<{ value: number }>();
  return `REQ-${row!.value}`;
}

export type SubmitResult =
  | { ok: true; id: string; number: string; application: string; approver: { name: string; email: string } | null; status: AccessStatus; existing?: boolean }
  | { ok: false; error: string };

export async function submitAccessRequest(
  env: AppEnv,
  input: { requesterId: string; applicationId: string; justification: string; sessionId?: string | null },
): Promise<SubmitResult> {
  const justification = justificationSchema.safeParse(input.justification);
  if (!justification.success) return { ok: false, error: justification.error.issues[0]!.message };
  const app = (await loadCatalog(env.DB)).find((a) => a.id === input.applicationId);
  if (!app) return { ok: false, error: "That app isn't in the catalog." };

  const check = await checkAccess(env, input.requesterId, app);
  if (check.alreadyHasAccess) return { ok: false, error: `You already have ${app.name}.` };
  if (check.openRequest) {
    const r = await env.DB.prepare("SELECT id FROM access_requests WHERE number = ?").bind(check.openRequest.number).first<{ id: string }>();
    return { ok: true, id: r!.id, number: check.openRequest.number, application: app.name, approver: check.approver, status: check.openRequest.status, existing: true };
  }
  if (app.requiresManagerApproval && !check.approver) return { ok: false, error: "There's no one to approve this request. Ask IT to set your manager." };

  const id = crypto.randomUUID();
  const number = await nextAccessNumber(env.DB);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO access_requests (id, number, requester_id, application_id, justification, status, approver_id, approver_email, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
    ).bind(id, number, input.requesterId, app.id, justification.data, check.approver?.id ?? null, check.approver?.email ?? null, input.sessionId ?? null, now, now),
    audit(env, input.requesterId, "access.request", id, { application: app.id, number }, now),
  ]);

  try {
    await env.ACCESS_WORKFLOW.create({ id, params: { requestId: id } });
    await env.DB.prepare("UPDATE access_requests SET workflow_instance_id = ? WHERE id = ?").bind(id, id).run();
  } catch (e) {
    console.error("[access] could not start workflow for", number, e);
  }
  return { ok: true, id, number, application: app.name, approver: check.approver, status: "PENDING" };
}

const audit = (env: AppEnv, actorId: string | null, action: string, entityId: string, data: Record<string, unknown>, now = Date.now()) =>
  env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, 'access_request', ?, ?, ?)").bind(
    crypto.randomUUID(),
    actorId,
    action,
    entityId,
    JSON.stringify(data),
    now,
  );

export const ACCESS_DECISION_EVENT = "access-decision";
export interface AccessDecisionPayload {
  decision: "approve" | "reject";
  note: string | null;
}

/**
 * Records the approver's decision (only while PENDING) and tells the workflow. Returns "already"
 * when someone already decided — a second click is harmless.
 */
export async function decideAccessRequest(
  env: AppEnv,
  requestId: string,
  decision: "approve" | "reject",
  note: string | null,
  by: { id: string | null; email: string | null },
): Promise<"approved" | "rejected" | "already" | "not_found"> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "UPDATE access_requests SET status = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING' RETURNING workflow_instance_id",
  )
    .bind(decision === "approve" ? "APPROVED" : "REJECTED", note, now, now, requestId)
    .first<{ workflow_instance_id: string | null }>();
  if (!row) {
    const exists = await env.DB.prepare("SELECT 1 AS ok FROM access_requests WHERE id = ?").bind(requestId).first();
    return exists ? "already" : "not_found";
  }
  await audit(env, by.id, decision === "approve" ? "access.approve" : "access.reject", requestId, { by: by.email, note }, now).run();
  if (row.workflow_instance_id) {
    try {
      const instance = await env.ACCESS_WORKFLOW.get(row.workflow_instance_id);
      await instance.sendEvent({ type: ACCESS_DECISION_EVENT, payload: { decision, note } satisfies AccessDecisionPayload });
    } catch (e) {
      console.warn("[access] sendEvent failed:", e instanceof Error ? e.message : e);
    }
  }
  return decision === "approve" ? "approved" : "rejected";
}

/** Mock provisioning: records the grant. A real connector (SCIM / the app's admin API) would go here. */
export async function provisionAccess(env: AppEnv, requestId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT requester_id, application_id, status FROM access_requests WHERE id = ?")
    .bind(requestId)
    .first<{ requester_id: string; application_id: string; status: AccessStatus }>();
  if (!r || (r.status !== "APPROVED" && r.status !== "PROVISIONED")) return false;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_grants (user_id, application_id, access_request_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(
      r.requester_id,
      r.application_id,
      requestId,
      now,
    ),
    env.DB.prepare("UPDATE access_requests SET status = 'PROVISIONED', provisioned_at = COALESCE(provisioned_at, ?), updated_at = ? WHERE id = ? AND status IN ('APPROVED','PROVISIONED')").bind(
      now,
      now,
      requestId,
    ),
    audit(env, null, "access.provision", requestId, { application: r.application_id, mock: true }, now),
  ]);
  return true;
}

/** Everything the workflow and emails need about one request. */
export async function loadAccessContext(env: AppEnv, requestId: string) {
  const r = await env.DB.prepare(
    `SELECT ar.*, a.name AS app_name, a.requires_manager_approval, u.name AS requester_name, u.email AS requester_email, u.department,
            t.name AS team_name, t.mailbox AS team_mailbox, m.name AS approver_name
     FROM access_requests ar JOIN applications a ON a.id = ar.application_id JOIN user u ON u.id = ar.requester_id
     LEFT JOIN teams t ON t.id = a.owner_team_id LEFT JOIN user m ON m.id = ar.approver_id WHERE ar.id = ?`,
  )
    .bind(requestId)
    .first<
      AccessRequestRow & {
        app_name: string;
        requires_manager_approval: number;
        requester_name: string;
        requester_email: string;
        department: string | null;
        team_name: string | null;
        team_mailbox: string | null;
        approver_name: string | null;
      }
    >();
  return r ?? null;
}
export type AccessContext = NonNullable<Awaited<ReturnType<typeof loadAccessContext>>>;

/** The employee's requests, newest first (portal list and the chat's status tool). */
export async function listAccessRequests(env: AppEnv, userId: string, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT ar.id, ar.number, ar.status, ar.justification, ar.decision_note, ar.created_at, ar.decided_at, ar.provisioned_at, ar.approver_email,
            a.name AS application, m.name AS approver_name
     FROM access_requests ar JOIN applications a ON a.id = ar.application_id LEFT JOIN user m ON m.id = ar.approver_id
     WHERE ar.requester_id = ? ORDER BY ar.created_at DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<{
      id: string;
      number: string;
      status: AccessStatus;
      justification: string;
      decision_note: string | null;
      created_at: number;
      decided_at: number | null;
      provisioned_at: number | null;
      approver_email: string | null;
      application: string;
      approver_name: string | null;
    }>();
  return results;
}
