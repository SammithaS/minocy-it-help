import type { AppEnv } from "../env";
import { dailyDigest, type DigestStats } from "./messages";
import { sendEmail } from "./send";

export async function computeDigest(env: AppEnv, now = Date.now()): Promise<DigestStats> {
  const since = now - 86_400_000;
  const db = env.DB;
  const [created, open, breached, cats, chats] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE created_at > ?").bind(since).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('RESOLVED','CLOSED')").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('RESOLVED','CLOSED') AND (sla_breached = 1 OR sla_due_at < ?)").bind(now).first<{ n: number }>(),
    db.prepare("SELECT category, COUNT(*) AS n FROM tickets WHERE created_at > ? GROUP BY category ORDER BY n DESC LIMIT 3").bind(since).all<{ category: string; n: number }>(),
    db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN outcome = 'resolved' THEN 1 ELSE 0 END) AS resolved, SUM(CASE WHEN outcome IN ('resolved','escalated') THEN 1 ELSE 0 END) AS decided FROM chat_sessions WHERE created_at > ?")
      .bind(since)
      .first<{ n: number; resolved: number | null; decided: number | null }>(),
  ]);
  return {
    date: new Date(now).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }),
    newTickets: created?.n ?? 0,
    open: open?.n ?? 0,
    breached: breached?.n ?? 0,
    topCategories: cats.results.map((c) => [c.category, c.n]),
    chats: chats?.n ?? 0,
    assistantResolutionRate: chats?.decided ? (chats.resolved ?? 0) / chats.decided : null,
  };
}

/** Cron (09:00 IST): one digest email per IT admin. */
export async function sendDailyDigest(env: AppEnv) {
  const stats = await computeDigest(env);
  const admins = env.IT_ADMIN_EMAIL
    ? [env.IT_ADMIN_EMAIL]
    : (await env.DB.prepare("SELECT email FROM user WHERE role = 'admin'").all<{ email: string }>()).results.map((r) => r.email);
  for (const to of admins) await sendEmail(env, dailyDigest(env, to, stats));
  return { admins: admins.length, stats };
}
