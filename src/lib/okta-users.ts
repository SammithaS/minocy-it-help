/**
 * People come from Okta: when someone asks for a sign-in code, their Okta profile decides whether they
 * may sign in, and refreshes their portal profile (name, department, city, manager).
 *
 * Break-glass: existing portal admins can always sign in, so a broken Okta token or outage never locks
 * IT out of the console. When Okta isn't configured at all, sign-in works from the portal's own users.
 */
import type { AppEnv } from "../env";
import { displayName, getOktaUser, isUsable, oktaConfigured, type OktaUser } from "./okta";

export type SyncResult = "synced" | "not_in_okta" | "inactive" | "okta_unavailable" | "not_configured";

async function upsertFromOkta(env: AppEnv, u: OktaUser, managerId: string | null): Promise<string> {
  const email = (u.profile.email || u.profile.login).toLowerCase();
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT id FROM user WHERE email = ? OR okta_id = ? LIMIT 1").bind(email, u.id).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE user SET name = ?, email = ?, okta_id = ?, department = COALESCE(?, department), location = COALESCE(?, location),
         manager_id = COALESCE(?, manager_id), email_verified = 1, updated_at = ? WHERE id = ?`,
    )
      .bind(displayName(u), email, u.id, u.profile.department ?? null, u.profile.city ?? null, managerId, now, existing.id)
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, role, department, location, manager_id, okta_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'employee', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, displayName(u), email, u.profile.department ?? null, u.profile.city ?? null, managerId, u.id, now, now)
    .run();
  return id;
}

/** Okta's managerId may be an Okta user id, a login or an email. Returns the manager's portal id. */
async function resolveManager(env: AppEnv, u: OktaUser): Promise<string | null> {
  const ref = u.profile.managerId?.trim();
  if (!ref) return null;
  const mgr = await getOktaUser(env, ref);
  if (!mgr || mgr.id === u.id || !isUsable(mgr)) return null;
  return upsertFromOkta(env, mgr, null);
}

export async function syncUserFromOkta(env: AppEnv, email: string): Promise<SyncResult> {
  if (!oktaConfigured(env)) return "not_configured";
  try {
    const u = await getOktaUser(env, email.trim().toLowerCase());
    if (!u) return "not_in_okta";
    if (!isUsable(u)) return "inactive";
    await upsertFromOkta(env, u, await resolveManager(env, u));
    return "synced";
  } catch (e) {
    console.error("[okta] user sync failed:", e instanceof Error ? e.message : e);
    return "okta_unavailable";
  }
}

/** May this email get a sign-in code? */
export async function mayRequestSignInCode(env: AppEnv, email: string): Promise<boolean> {
  const r = await syncUserFromOkta(env, email);
  if (r === "synced" || r === "not_configured") return true;
  const local = await env.DB.prepare("SELECT role FROM user WHERE email = ?").bind(email.trim().toLowerCase()).first<{ role: string }>();
  return local?.role === "admin"; // break-glass for IT admins only
}
