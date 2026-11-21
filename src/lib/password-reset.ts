/**
 * Self-service password reset against the mock directory (stands in for Entra ID / AD):
 *
 *   start → 6-digit code emailed (HMAC stored, 10 min, 5 tries)
 *   → verify (from the chat card via a callable, never as a chat message)
 *   → the employee approves the reset in an approval card
 *   → complete: account unlocked + must-change flag, one-time "set new password" link emailed (30 min)
 *   → set: the public page checks the policy and records the change (no password is stored — mock)
 *
 * Codes and links are emailed as `sensitive`, so the admin Outbox never shows them.
 */
import * as msg from "../email/access-messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { verifyLink } from "./tokens";

export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_RESETS_PER_DAY = 3;
/** After verifying the code, the employee has this long to approve the reset. */
const VERIFIED_WINDOW_MS = 15 * 60_000;
export const LINK_MINUTES = 30;

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

interface DirectoryRow {
  user_id: string;
  username: string;
  status: "active" | "locked" | "disabled";
  name: string;
  email: string;
}

const directoryRow = (env: AppEnv, userId: string) =>
  env.DB.prepare("SELECT d.user_id, d.username, d.status, u.name, u.email FROM directory_accounts d JOIN user u ON u.id = d.user_id WHERE d.user_id = ?")
    .bind(userId)
    .first<DirectoryRow>();

const audit = (env: AppEnv, actorId: string | null, action: string, resetId: string, data: Record<string, unknown> = {}) =>
  env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, 'password_reset', ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, action, resetId, JSON.stringify(data), Date.now())
    .run();

export type StartResult =
  | { ok: true; resetId: string; maskedEmail: string; accountLocked: boolean; expiresAt: number }
  | { ok: false; reason: "no_account" | "disabled" | "rate_limited" };

export async function startPasswordReset(env: AppEnv, input: { userId: string; sessionId?: string | null }, now = Date.now()): Promise<StartResult> {
  const acct = await directoryRow(env, input.userId);
  if (!acct) return { ok: false, reason: "no_account" };
  if (acct.status === "disabled") return { ok: false, reason: "disabled" };
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?")
    .bind(input.userId, now - 86_400_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_RESETS_PER_DAY) return { ok: false, reason: "rate_limited" };

  const resetId = crypto.randomUUID();
  const code = sixDigits();
  const expiresAt = now + CODE_MINUTES * 60_000;
  await env.DB.prepare("INSERT INTO password_resets (id, user_id, session_id, code_hash, code_expires_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(resetId, input.userId, input.sessionId ?? null, await hashCode(env.BETTER_AUTH_SECRET, resetId, code), expiresAt, now)
    .run();
  await audit(env, input.userId, "password.reset_start", resetId, { locked: acct.status === "locked" });
  await sendEmail(env, msg.passwordResetCode(env, acct.email, acct.name, code, CODE_MINUTES));
  return { ok: true, resetId, maskedEmail: maskEmail(acct.email), accountLocked: acct.status === "locked", expiresAt };
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

export type CompleteResult = { ok: true; maskedEmail: string; unlocked: boolean } | { ok: false; reason: "not_verified" | "expired" | "not_found" };

/** After the employee approves: unlock, force a change, email the one-time link. Idempotent. */
export async function completePasswordReset(env: AppEnv, input: { resetId: string; userId: string }, now = Date.now()): Promise<CompleteResult> {
  const r = await env.DB.prepare("SELECT verified_at, completed_at FROM password_resets WHERE id = ? AND user_id = ?")
    .bind(input.resetId, input.userId)
    .first<{ verified_at: number | null; completed_at: number | null }>();
  const acct = await directoryRow(env, input.userId);
  if (!r || !acct) return { ok: false, reason: "not_found" };
  if (r.completed_at) return { ok: true, maskedEmail: maskEmail(acct.email), unlocked: false };
  if (!r.verified_at) return { ok: false, reason: "not_verified" };
  if (now - r.verified_at > VERIFIED_WINDOW_MS) return { ok: false, reason: "expired" };

  const done = await env.DB.prepare("UPDATE password_resets SET completed_at = ? WHERE id = ? AND completed_at IS NULL RETURNING id").bind(now, input.resetId).first();
  if (!done) return { ok: true, maskedEmail: maskEmail(acct.email), unlocked: false };
  const unlocked = acct.status === "locked";
  await env.DB.prepare("UPDATE directory_accounts SET status = 'active', locked_at = NULL, must_change_password = 1, updated_at = ? WHERE user_id = ?")
    .bind(now, input.userId)
    .run();
  await audit(env, input.userId, "password.reset_approved", input.resetId, { unlocked });
  await sendEmail(env, await msg.passwordResetLink(env, acct.email, acct.name, input.resetId, LINK_MINUTES, unlocked));
  return { ok: true, maskedEmail: maskEmail(acct.email), unlocked };
}

/** Policy for the mock directory: 12+ characters, 3 of 4 character kinds, not the username. */
export function passwordProblem(pw: string, username: string): string | null {
  if (pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 128) return "That's too long (128 characters max).";
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds < 3) return "Mix at least three of: lowercase, uppercase, numbers, symbols.";
  const u = username.toLowerCase().replace(/[^a-z]/g, "");
  if (u.length >= 3 && pw.toLowerCase().includes(u)) return "Don't include your username.";
  if (/^(.)\1+$/.test(pw) || /password|minocy|qwerty|123456/i.test(pw)) return "That password is too easy to guess.";
  return null;
}

export type LinkCheck = { ok: true; resetId: string; userId: string; username: string; name: string; email: string } | { ok: false; reason: "expired" | "used" };

export async function checkSetPasswordLink(env: AppEnv, token: string, now = Date.now()): Promise<LinkCheck> {
  const payload = await verifyLink(env.BETTER_AUTH_SECRET, token, "set-password", now);
  if (!payload) return { ok: false, reason: "expired" };
  const r = await env.DB.prepare(
    "SELECT r.id, r.user_id, r.completed_at, r.link_used_at, d.username, u.name, u.email FROM password_resets r JOIN directory_accounts d ON d.user_id = r.user_id JOIN user u ON u.id = r.user_id WHERE r.id = ?",
  )
    .bind(payload.sub)
    .first<{ id: string; user_id: string; completed_at: number | null; link_used_at: number | null; username: string; name: string; email: string }>();
  if (!r || !r.completed_at) return { ok: false, reason: "expired" };
  if (r.link_used_at) return { ok: false, reason: "used" };
  return { ok: true, resetId: r.id, userId: r.user_id, username: r.username, name: r.name, email: r.email };
}

export type SetResult = { ok: true } | { ok: false; reason: "expired" | "used" | "policy" | "mismatch"; message?: string };

export async function setNewPassword(env: AppEnv, token: string, password: string, confirm: string, now = Date.now()): Promise<SetResult> {
  const link = await checkSetPasswordLink(env, token, now);
  if (!link.ok) return link;
  if (password !== confirm) return { ok: false, reason: "mismatch", message: "The two passwords don't match." };
  const problem = passwordProblem(password, link.username);
  if (problem) return { ok: false, reason: "policy", message: problem };

  const used = await env.DB.prepare("UPDATE password_resets SET link_used_at = ? WHERE id = ? AND link_used_at IS NULL RETURNING id").bind(now, link.resetId).first();
  if (!used) return { ok: false, reason: "used" };
  // Mock directory: record the change only. A real connector would call the IdP's password API here.
  await env.DB.prepare("UPDATE directory_accounts SET status = 'active', locked_at = NULL, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(now, now, link.userId)
    .run();
  await audit(env, link.userId, "password.changed", link.resetId);
  await sendEmail(env, msg.passwordChanged(env, link.email, link.name));
  return { ok: true };
}
