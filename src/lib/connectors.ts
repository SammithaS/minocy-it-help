/**
 * Access connectors: how an approved request becomes real access in the target system.
 *
 *   github  org (or team) membership invite via the GitHub REST API — needs the requester's GitHub
 *           username and the GITHUB_TOKEN secret (fine-grained token: Organization → Members: Read & write).
 *           config: { org, team? }   A new member gets an invite and must accept it (state "pending").
 *   okta    add the requester's Okta user to a group (apps assigned to the group are provisioned by Okta).
 *           config: { groupId }      Needs OKTA_DOMAIN + OKTA_API_TOKEN.
 *   atlassian  Jira / Confluence Cloud: find the person on the site by email (invite them with the
 *           configured products if they're not there), then add them to the product's group.
 *           config: { group, products? }  e.g. { group: "jira-software-users", products: "jira-software" }
 *           Needs ATLASSIAN_SITE + ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN.
 *
 * grant() is idempotent (re-inviting / re-adding is a no-op on both APIs). check() reads the real state.
 * Retryable problems (rate limits, outages) throw ConnectorError(retryable) so the workflow step retries;
 * anything else is returned as "failed" and becomes a ticket for the app's team.
 */
import type { AppEnv } from "../env";
import { addToGroup, AtlassianError, findUserByEmail, getGroup as getAtlassianGroup, inviteUser, isInGroup } from "./atlassian";
import { addUserToGroup, getGroup, getOktaUser, OktaError, userGroups } from "./okta";

export const CONNECTOR_KINDS = ["github", "okta", "atlassian"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export interface GrantTarget {
  app: { name: string; connector: ConnectorKind; config: Record<string, string> };
  user: { email: string; name: string };
  /** GitHub username. */
  externalUsername: string | null;
}

export type GrantResult =
  | { status: "active"; detail: string }
  | { status: "pending"; detail: string }
  | { status: "failed"; detail: string };

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const GITHUB_USERNAME = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;

/** What the request card must ask the employee for, per connector. */
export const CONNECTOR_NEEDS: Record<ConnectorKind, { username: boolean; label?: string; help?: string }> = {
  github: { username: true, label: "Your GitHub username", help: "You'll get an invite from GitHub to accept." },
  okta: { username: false },
  atlassian: { username: false },
};

// ───────────────────────────── GitHub ─────────────────────────────

async function gh(env: AppEnv, method: string, path: string, body?: unknown) {
  if (!env.GITHUB_TOKEN) throw new ConnectorError("GitHub isn't configured (GITHUB_TOKEN secret).", false);
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "minocy-it-help",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (res.status === 429 || res.status >= 500 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new ConnectorError(`GitHub ${res.status}: ${String(json.message ?? text).slice(0, 200)}`, true);
  }
  return { status: res.status, json };
}

const ghPath = (config: Record<string, string>, username: string) => {
  const org = encodeURIComponent(config.org ?? "");
  const user = encodeURIComponent(username);
  return config.team ? `/orgs/${org}/teams/${encodeURIComponent(config.team)}/memberships/${user}` : `/orgs/${org}/memberships/${user}`;
};

async function githubGrant(env: AppEnv, t: GrantTarget): Promise<GrantResult> {
  const { org, team } = t.app.config;
  if (!org) return { status: "failed", detail: "GitHub connector has no organization configured." };
  const username = t.externalUsername ?? "";
  if (!GITHUB_USERNAME.test(username)) return { status: "failed", detail: `"${username}" isn't a valid GitHub username.` };
  const where = team ? `${org}/${team}` : org;

  // Team membership invites to the org too; org membership uses role "member" (never admin).
  const r = await gh(env, "PUT", ghPath(t.app.config, username), team ? { role: "member" } : { role: "member" });
  if (r.status === 404) {
    const exists = await gh(env, "GET", `/users/${encodeURIComponent(username)}`);
    return { status: "failed", detail: exists.status === 404 ? `GitHub user "${username}" doesn't exist.` : `GitHub ${team ? `team ${where}` : `organization ${org}`} not found or the token can't see it.` };
  }
  if (r.status === 401 || r.status === 403) return { status: "failed", detail: `GitHub refused (${r.status}): the token needs Members: Read & write on ${org}. ${String(r.json.message ?? "")}`.trim() };
  if (r.status === 422) return { status: "failed", detail: `GitHub couldn't add ${username}: ${String(r.json.message ?? "validation failed")}` };
  if (r.status !== 200) return { status: "failed", detail: `GitHub returned ${r.status}: ${String(r.json.message ?? "")}` };
  return r.json.state === "active"
    ? { status: "active", detail: `${username} is a member of ${where} on GitHub.` }
    : { status: "pending", detail: `Invited ${username} to ${where} on GitHub — waiting for them to accept.` };
}

async function githubCheck(env: AppEnv, t: GrantTarget): Promise<"active" | "pending" | "none"> {
  const r = await gh(env, "GET", ghPath(t.app.config, t.externalUsername ?? ""));
  if (r.status !== 200) return "none";
  return r.json.state === "active" ? "active" : "pending";
}

// ───────────────────────────── Okta ─────────────────────────────

const wrapOkta = (e: unknown): never => {
  if (e instanceof OktaError) throw new ConnectorError(e.message, e.retryable);
  throw e;
};

async function oktaGrant(env: AppEnv, t: GrantTarget): Promise<GrantResult> {
  const { groupId } = t.app.config;
  if (!groupId) return { status: "failed", detail: "Okta connector has no group configured." };
  try {
    const user = await getOktaUser(env, t.user.email);
    if (!user) return { status: "failed", detail: `${t.user.email} isn't a user in Okta.` };
    const group = await getGroup(env, groupId);
    if (!group) return { status: "failed", detail: `Okta group ${groupId} not found.` };
    await addUserToGroup(env, groupId, user.id);
    return { status: "active", detail: `Added to the Okta group "${group.profile.name}".` };
  } catch (e) {
    if (e instanceof OktaError && !e.retryable) return { status: "failed", detail: e.message };
    return wrapOkta(e);
  }
}

async function oktaCheck(env: AppEnv, t: GrantTarget): Promise<"active" | "pending" | "none"> {
  try {
    const user = await getOktaUser(env, t.user.email);
    if (!user) return "none";
    return (await userGroups(env, user.id)).some((g) => g.id === t.app.config.groupId) ? "active" : "none";
  } catch (e) {
    return wrapOkta(e);
  }
}

// ───────────────────────────── Atlassian (Jira / Confluence) ─────────────────────────────

const atlProducts = (config: Record<string, string>) =>
  (config.products ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

async function atlassianGrant(env: AppEnv, t: GrantTarget): Promise<GrantResult> {
  const group = t.app.config.group;
  if (!group) return { status: "failed", detail: "Atlassian connector has no group configured." };
  try {
    let user = await findUserByEmail(env, t.user.email);
    let invited = false;
    if (!user) {
      const products = atlProducts(t.app.config);
      if (!products.length) return { status: "failed", detail: `${t.user.email} isn't on the Atlassian site and the app has no products to invite them to.` };
      user = await inviteUser(env, t.user.email, products);
      invited = true;
    }
    await addToGroup(env, group, user.accountId);
    return { status: "active", detail: `${invited ? "Invited to the Atlassian site and added" : "Added"} to the group "${group}".` };
  } catch (e) {
    if (e instanceof AtlassianError) {
      if (e.retryable) throw new ConnectorError(e.message, true);
      return { status: "failed", detail: e.message };
    }
    throw e;
  }
}

async function atlassianCheck(env: AppEnv, t: GrantTarget): Promise<"active" | "pending" | "none"> {
  try {
    const user = await findUserByEmail(env, t.user.email);
    if (!user) return "none";
    return (await isInGroup(env, t.app.config.group ?? "", user.accountId)) ? "active" : "none";
  } catch (e) {
    if (e instanceof AtlassianError) throw new ConnectorError(e.message, e.retryable);
    throw e;
  }
}

// ───────────────────────────── dispatch ─────────────────────────────

const GRANT = { github: githubGrant, okta: oktaGrant, atlassian: atlassianGrant } satisfies Record<ConnectorKind, unknown>;
const CHECK = { github: githubCheck, okta: oktaCheck, atlassian: atlassianCheck } satisfies Record<ConnectorKind, unknown>;

export function grantAccess(env: AppEnv, t: GrantTarget): Promise<GrantResult> {
  return GRANT[t.app.connector](env, t);
}

export function checkAccess(env: AppEnv, t: GrantTarget): Promise<"active" | "pending" | "none"> {
  return CHECK[t.app.connector](env, t);
}

/** Validates an app's connector settings before an admin saves them (live lookups when configured). */
export async function validateConnector(env: AppEnv, connector: ConnectorKind, config: Record<string, string>): Promise<string | null> {
  if (connector === "github") {
    if (!config.org?.match(/^[A-Za-z0-9-]{1,39}$/)) return "Enter the GitHub organization name (as in github.com/<org>).";
    if (config.team && !config.team.match(/^[A-Za-z0-9._-]{1,100}$/)) return "Team is the team's slug, e.g. design-team.";
    if (!env.GITHUB_TOKEN) return null; // saved now, checked when the token is added
    const r = await gh(env, "GET", config.team ? `/orgs/${encodeURIComponent(config.org)}/teams/${encodeURIComponent(config.team)}` : `/orgs/${encodeURIComponent(config.org)}`);
    if (r.status === 404) return config.team ? `Team "${config.team}" not found in ${config.org} (or the token can't see it).` : `Organization "${config.org}" not found (or the token can't see it).`;
    if (r.status !== 200) return `GitHub returned ${r.status}: ${String(r.json.message ?? "")}`;
    return null;
  }
  if (connector === "atlassian") {
    if (!config.group?.trim()) return 'Enter the Atlassian group that grants access, e.g. "jira-software-users" or "confluence-users".';
    const bad = atlProducts(config).find((p) => !/^(jira-software|jira-servicedesk|jira-product-discovery|confluence)$/.test(p));
    if (bad) return `Unknown product "${bad}" — use jira-software, jira-servicedesk, jira-product-discovery or confluence.`;
    if (!env.ATLASSIAN_SITE || !env.ATLASSIAN_EMAIL || !env.ATLASSIAN_API_TOKEN) return null;
    try {
      return (await getAtlassianGroup(env, config.group.trim())) ? null : `Group "${config.group}" not found on ${env.ATLASSIAN_SITE}.`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  if (!config.groupId?.match(/^[A-Za-z0-9]{10,30}$/)) return "Enter the Okta group id (Directory → Groups → the group's URL ends with it, e.g. 00g1abcd…).";
  if (!env.OKTA_DOMAIN || !env.OKTA_API_TOKEN) return null;
  try {
    return (await getGroup(env, config.groupId)) ? null : `Okta group ${config.groupId} not found.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
