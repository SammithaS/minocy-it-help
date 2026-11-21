/**
 * Atlassian Cloud (Jira / Confluence) client — one site, shared users and groups across products.
 *   ATLASSIAN_SITE       e.g. "acme.atlassian.net"
 *   ATLASSIAN_EMAIL      the admin account the API token belongs to
 *   ATLASSIAN_API_TOKEN  https://id.atlassian.com/manage-profile/security/api-tokens
 * Product access is granted through group membership (e.g. "jira-software-users", "confluence-users").
 * https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
import type { AppEnv } from "../env";

export class AtlassianError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const atlassianConfigured = (env: AppEnv) => !!(env.ATLASSIAN_SITE && env.ATLASSIAN_EMAIL && env.ATLASSIAN_API_TOKEN);

async function jira<T>(env: AppEnv, method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  if (!atlassianConfigured(env)) throw new AtlassianError("Atlassian isn't configured (ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN).", 0, false);
  const site = env.ATLASSIAN_SITE!.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const res = await fetch(`https://${site}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`)}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) throw new AtlassianError(`Atlassian ${res.status}: ${text.slice(0, 200)}`, res.status, true);
  const json = (() => {
    try {
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  })();
  return { status: res.status, json };
}

const errText = (json: unknown) => {
  const j = json as { errorMessages?: string[]; errors?: Record<string, string>; message?: string } | null;
  return [...(j?.errorMessages ?? []), ...Object.values(j?.errors ?? {}), j?.message].filter(Boolean).join("; ") || "no details";
};

interface AtlassianUser {
  accountId: string;
  emailAddress?: string;
  displayName: string;
  accountType: string;
}

/** Exact email match among site users (email must be visible to the admin token, which it is for site admins). */
export async function findUserByEmail(env: AppEnv, email: string): Promise<AtlassianUser | null> {
  const r = await jira<AtlassianUser[]>(env, "GET", `/user/search?query=${encodeURIComponent(email)}`);
  if (r.status !== 200) throw new AtlassianError(`Atlassian user search → ${r.status}: ${errText(r.json)}`, r.status, false);
  return (r.json ?? []).find((u) => u.accountType === "atlassian" && u.emailAddress?.toLowerCase() === email.toLowerCase()) ?? null;
}

/** Invites the person to the site with access to the given products ("jira-software", "confluence"). */
export async function inviteUser(env: AppEnv, email: string, products: string[]): Promise<AtlassianUser> {
  const r = await jira<AtlassianUser>(env, "POST", "/user", { emailAddress: email, products });
  if (r.status !== 201 || !r.json) throw new AtlassianError(`Atlassian invite → ${r.status}: ${errText(r.json)}`, r.status, false);
  return r.json;
}

export async function getGroup(env: AppEnv, groupName: string): Promise<{ groupId: string; name: string } | null> {
  const r = await jira<{ groups: { groupId: string; name: string }[] }>(env, "GET", `/groups/picker?query=${encodeURIComponent(groupName)}&maxResults=50`);
  if (r.status !== 200) throw new AtlassianError(`Atlassian group lookup → ${r.status}: ${errText(r.json)}`, r.status, false);
  return r.json?.groups.find((g) => g.name === groupName) ?? null;
}

/** Idempotent: Atlassian answers 400 "already a member" when the user is in the group. */
export async function addToGroup(env: AppEnv, groupName: string, accountId: string): Promise<void> {
  const r = await jira(env, "POST", `/group/user?groupname=${encodeURIComponent(groupName)}`, { accountId });
  if (r.status === 201) return;
  const msg = errText(r.json);
  if (r.status === 400 && /already a member/i.test(msg)) return;
  throw new AtlassianError(`Atlassian add to group "${groupName}" → ${r.status}: ${msg}`, r.status, false);
}

export async function isInGroup(env: AppEnv, groupName: string, accountId: string): Promise<boolean> {
  const r = await jira<{ name: string }[]>(env, "GET", `/user/groups?accountId=${encodeURIComponent(accountId)}`);
  if (r.status !== 200) return false;
  return (r.json ?? []).some((g) => g.name === groupName);
}
