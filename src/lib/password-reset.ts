/**
 * Self-service password reset against Okta (the company directory):
 *
 *   start → look the person up in Okta (unknown / suspended → hand over to IT)
 *         → 6-digit code emailed (HMAC stored, 10 min, 5 tries, 3 resets / day)
 *   → verify (from the chat card via a callable, never as a chat message)
 *   → the employee approves the reset in an approval card
 *   → complete: Okta unlocks the account if it's locked, then emails its own reset link
 *     (lifecycle/reset_password?sendEmail=true). No password or link ever passes through this app.
 *
 * The code is emailed as `sensitive`, so the admin Outbox never shows it.
 */
import * as msg from "../email/access-messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { getOktaUser, isUsable, oktaConfigured, OktaError, sendPasswordReset, unlockUser } from "./okta";

export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_RESETS_PER_DAY = 3;
/** After verifying the code, the employee has this long to approve the reset. */
const VERIFIED_WINDOW_MS = 15 * 60_000;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashCode(secret: string, resetId: string, code: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${resetId}:${code}`)));
}

function sixDigits() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, "0");
}

export function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

const portalUser = (env: AppEnv, userId: string) =>
  env.DB.prepare("SELECT id, name, email, okta_id FROM user WHERE id = ?").bind(userId).first<{ id: string; name: string; email: string; okta_id: string | null }>();

const audit = (env: AppEnv, actorId: string | null, action: string, resetId: string, data: Record<string, unknown> = {}) =>
  env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, 'password_reset', ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, action, resetId, JSON.stringify(data), Date.now())
    .run();

export type StartResult =
  | { ok: true; resetId: string; maskedEmail: string; accountLocked: boolean; expiresAt: number }
  | { ok: false; reason: "no_account" | "disabled" | "rate_limited" | "unavailable" };

export async function startPasswordReset(env: AppEnv, input: { userId: string; sessionId?: string | null }, now = Date.now()): Promise<StartResult> {
  if (!oktaConfigured(env)) return { ok: false, reason: "unavailable" };
  const me = await portalUser(env, input.userId);
  if (!me) return { ok: false, reason: "no_account" };
  let okta;
  try {
    okta = await getOktaUser(env, me.okta_id ?? me.email);
  } catch (e) {
    console.error("[password] Okta lookup failed:", e instanceof Error ? e.message : e);
    return { ok: false, reason: "unavailable" };
  }
  if (!okta) return { ok: false, reason: "no_account" };
  if (!isUsable(okta)) return { ok: false, reason: "disabled" };
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?")
    .bind(input.userId, now - 86_400_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_RESETS_PER_DAY) return { ok: false, reason: "rate_limited" };

  const locked = okta.status === "LOCKED_OUT";
  const resetId = crypto.randomUUID();
  const code = sixDigits();
  const expiresAt = now + CODE_MINUTES * 60_000;
  await env.DB.prepare("INSERT INTO password_resets (id, user_id, session_id, code_hash, code_expires_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(resetId, input.userId, input.sessionId ?? null, await hashCode(env.BETTER_AUTH_SECRET, resetId, code), expiresAt, now)
    .run();
  await audit(env, input.userId, "password.reset_start", resetId, { locked, oktaStatus: okta.status });
  await sendEmail(env, msg.passwordResetCode(env, me.email, me.name, code, CODE_MINUTES));
  return { ok: true, resetId, maskedEmail: maskEmail(me.email), accountLocked: locked, expiresAt };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "wrong"; attemptsLeft: number }
  | { ok: false; reason: "expired" | "too_many" | "not_found" };

export async function verifyResetCode(env: AppEnv, input: { resetId: string; userId: string; code: string }, now = Date.now()): Promise<VerifyResult> {
  const r = await env.DB.prepare("SELECT code_hash, code_expires_at, attempts, verified_at FROM password_resets WHERE id = ? AND user_id = ? AND completed_at IS NULL")
    .bind(input.resetId, input.userId)
    .first<{ code_hash: string; code_expires_at: number; attempts: number; verified_at: number | null }>();
  if (!r) return { ok: false, reason: "not_found" };
  if (r.verified_at) return { ok: true };
  if (r.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "too_many" };
  if (r.code_expires_at < now) return { ok: false, reason: "expired" };

  // Count the attempt before comparing, so parallel guesses can't skip the limit.
  const counted = await env.DB.prepare("UPDATE password_resets SET attempts = attempts + 1 WHERE id = ? AND attempts < ? RETURNING attempts")
    .bind(input.resetId, MAX_CODE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!counted) return { ok: false, reason: "too_many" };

  const code = input.code.replace(/\D/g, "");
  const candidate = enc.encode(await hashCode(env.BETTER_AUTH_SECRET, input.resetId, code));
  const stored = enc.encode(r.code_hash);
  const match = code.length === 6 && candidate.byteLength === stored.byteLength && crypto.subtle.timingSafeEqual(candidate, stored);
  if (!match) {
    const left = MAX_CODE_ATTEMPTS - counted.attempts;
    if (left <= 0) await audit(env, input.userId, "password.reset_locked_out", input.resetId);
    return left > 0 ? { ok: false, reason: "wrong", attemptsLeft: left } : { ok: false, reason: "too_many" };
  }
  await env.DB.prepare("UPDATE password_resets SET verified_at = ? WHERE id = ?").bind(now, input.resetId).run();
  await audit(env, input.userId, "password.reset_verified", input.resetId);
  return { ok: true };
}

export type CompleteResult = { ok: true; maskedEmail: string; unlocked: boolean } | { ok: false; reason: "not_verified" | "expired" | "not_found" | "okta_error" };

/** After the employee approves: unlock in Okta if needed, then Okta emails its reset link. Idempotent. */
export async function completePasswordReset(env: AppEnv, input: { resetId: string; userId: string }, now = Date.now()): Promise<CompleteResult> {
  const r = await env.DB.prepare("SELECT verified_at, completed_at FROM password_resets WHERE id = ? AND user_id = ?")
    .bind(input.resetId, input.userId)
    .first<{ verified_at: number | null; completed_at: number | null }>();
  const me = await portalUser(env, input.userId);
  if (!r || !me) return { ok: false, reason: "not_found" };
  if (r.completed_at) return { ok: true, maskedEmail: maskEmail(me.email), unlocked: false };
  if (!r.verified_at) return { ok: false, reason: "not_verified" };
  if (now - r.verified_at > VERIFIED_WINDOW_MS) return { ok: false, reason: "expired" };

  let unlocked = false;
  try {
    const okta = await getOktaUser(env, me.okta_id ?? me.email);
    if (!okta || !isUsable(okta)) return { ok: false, reason: "not_found" };
    if (okta.status === "LOCKED_OUT") {
      await unlockUser(env, okta.id);
      unlocked = true;
    }
    await sendPasswordReset(env, okta.id);
  } catch (e) {
    const detail = e instanceof OktaError ? e.message : String(e);
    console.error("[password] Okta reset failed:", detail);
    await audit(env, input.userId, "password.reset_failed", input.resetId, { detail: detail.slice(0, 300) });
    return { ok: false, reason: "okta_error" };
  }
  await env.DB.prepare("UPDATE password_resets SET completed_at = ? WHERE id = ? AND completed_at IS NULL").bind(now, input.resetId).run();
  await audit(env, input.userId, "password.reset_approved", input.resetId, { unlocked, via: "okta" });
  return { ok: true, maskedEmail: maskEmail(me.email), unlocked };
}
