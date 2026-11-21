/**
 * Okta Management API client (users, lifecycle, groups). Configured with two Worker secrets:
 *   OKTA_DOMAIN     e.g. "acme.okta.com" or "integrator-1234567.okta.com"
 *   OKTA_API_TOKEN  an API token (Security → API → Tokens) from an admin with user + group management
 * https://developer.okta.com/docs/api/openapi/okta-management/
 */
import type { AppEnv } from "../env";

export class OktaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Worth retrying (rate limit / Okta outage) vs a configuration or data problem. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface OktaUser {
  id: string;
  /** ACTIVE, PROVISIONED, STAGED, RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT, SUSPENDED, DEPROVISIONED */
  status: string;
  profile: {
    login: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
    department?: string | null;
    city?: string | null;
    title?: string | null;
    /** Okta's standard manager attribute — we accept an Okta user id, a login or an email. */
    managerId?: string | null;
  };
}

export const oktaConfigured = (env: AppEnv) => !!(env.OKTA_DOMAIN && env.OKTA_API_TOKEN);

function base(env: AppEnv) {
  if (!oktaConfigured(env)) throw new OktaError("Okta isn't configured (OKTA_DOMAIN / OKTA_API_TOKEN).", 0, false);
  const domain = env.OKTA_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${domain}/api/v1`;
}

async function okta<T>(env: AppEnv, method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: {
      Authorization: `SSWS ${env.OKTA_API_TOKEN}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    throw new OktaError(`Okta ${method} ${path.split("?")[0]} → ${res.status}: ${text}`, res.status, retryable);
  }
  return res.status === 204 ? ({} as T) : ((await res.json()) as T);
}

/** By Okta id, login or email (Okta resolves login/email in the path). */
export const getOktaUser = (env: AppEnv, idOrLogin: string) => okta<OktaUser>(env, "GET", `/users/${encodeURIComponent(idOrLogin)}`);

export function displayName(u: OktaUser): string {
  const p = u.profile;
  return (p.displayName || [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email).trim();
}

/** Can this person sign in / use self-service? */
export const isUsable = (u: OktaUser) => !["SUSPENDED", "DEPROVISIONED", "STAGED"].includes(u.status);

export async function unlockUser(env: AppEnv, userId: string) {
  await okta(env, "POST", `/users/${userId}/lifecycle/unlock`);
}

/** Okta emails the user its own reset link (sendEmail=true); nothing secret comes back to us. */
export async function sendPasswordReset(env: AppEnv, userId: string) {
  await okta(env, "POST", `/users/${userId}/lifecycle/reset_password?sendEmail=true`);
}

export async function addUserToGroup(env: AppEnv, groupId: string, userId: string) {
  await okta(env, "PUT", `/groups/${encodeURIComponent(groupId)}/users/${userId}`);
}

export async function userGroups(env: AppEnv, userId: string): Promise<{ id: string; profile: { name: string } }[]> {
  return (await okta<{ id: string; profile: { name: string } }[]>(env, "GET", `/users/${userId}/groups`)) ?? [];
}

export const getGroup = (env: AppEnv, groupId: string) => okta<{ id: string; profile: { name: string } }>(env, "GET", `/groups/${encodeURIComponent(groupId)}`);
