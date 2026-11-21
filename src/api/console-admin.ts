/**
 * Admin console API: routing & SLA settings, the KB editor, knowledge-gap proposals, and analytics
 * (analytics is open to all IT staff).
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { PRIORITIES } from "../db/schema";
import { articleInputSchema, nextArticleId, validateArticle, type ArticleMeta } from "../lib/kb-index";
import { TICKET_CATEGORIES } from "../org-config";
import { saveRevision } from "../workflows/kb-reindex-workflow";
import { requireRole, type HonoEnv } from "./context";

const articleId = zValidator("param", z.object({ id: z.string().regex(/^KB-\d{3}$/) }));
const uuidParam = zValidator("param", z.object({ id: z.uuid() }));

interface ArticleRow {
  id: string;
  title: string;
  category: string;
  tags: string;
  os: string;
  ticket_category: string;
  priority: string;
  action: string | null;
  body: string;
  managed_by: string;
  updated_at: number;
}
const rowMeta = (a: ArticleRow): ArticleMeta => ({
  id: a.id,
  title: a.title,
  category: a.category,
  tags: JSON.parse(a.tags) as string[],
  os: JSON.parse(a.os) as ArticleMeta["os"],
  ticket_category: a.ticket_category as ArticleMeta["ticket_category"],
  priority: a.priority as ArticleMeta["priority"],
  action: (a.action ?? "troubleshoot") as ArticleMeta["action"],
});

export const consoleAdminRoutes = new Hono<HonoEnv>()
  // ───────────── routing & SLA settings ─────────────
  .get("/console/settings", requireRole("admin"), async (c) => {
    const [teams, routing, sla] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT id, name, mailbox FROM teams ORDER BY name"),
      c.env.DB.prepare("SELECT category, team_id FROM routing_rules"),
      c.env.DB.prepare("SELECT priority, resolve_minutes, working_hours_only FROM sla_policies"),
    ]);
    return c.json({
      categories: TICKET_CATEGORIES,
      teams: teams!.results as { id: string; name: string; mailbox: string }[],
      routing: routing!.results as { category: string; team_id: string }[],
      sla: (sla!.results as { priority: string; resolve_minutes: number; working_hours_only: number }[]).map((s) => ({
        priority: s.priority,
        minutes: s.resolve_minutes,
        workingHoursOnly: !!s.working_hours_only,
      })),
    });
  })
  .put(
    "/console/settings",
    requireRole("admin"),
    zValidator(
      "json",
      z.object({
        routing: z.array(z.object({ category: z.enum(TICKET_CATEGORIES), teamId: z.string().min(1) })).max(20),
        sla: z.array(z.object({ priority: z.enum(PRIORITIES), minutes: z.number().int().min(15).max(60 * 24 * 30), workingHoursOnly: z.boolean() })).max(4),
      }),
    ),
    async (c) => {
      const { routing, sla } = c.req.valid("json");
      const teamIds = new Set((await c.env.DB.prepare("SELECT id FROM teams").all<{ id: string }>()).results.map((t) => t.id));
      const bad = routing.find((r) => !teamIds.has(r.teamId));
      if (bad) return c.json({ error: `Unknown team for ${bad.category}` }, 400);
      const now = Date.now();
      await c.env.DB.batch([
        ...routing.map((r) =>
          c.env.DB.prepare("INSERT INTO routing_rules (category, team_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(category) DO UPDATE SET team_id = excluded.team_id, updated_at = excluded.updated_at").bind(
            r.category,
            r.teamId,
            now,
          ),
        ),
        ...sla.map((s) =>
          c.env.DB.prepare(
            "INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(priority) DO UPDATE SET resolve_minutes = excluded.resolve_minutes, working_hours_only = excluded.working_hours_only, updated_at = excluded.updated_at",
          ).bind(s.priority, s.minutes, s.workingHoursOnly ? 1 : 0, now),
        ),
        c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, entity, data, created_at) VALUES (?, ?, 'settings.update', 'settings', ?, ?)").bind(
          crypto.randomUUID(),
          c.get("user")!.id,
          JSON.stringify({ routing, sla }),
          now,
        ),
      ]);
      return c.json({ ok: true });
    },
  )

  // ───────────── KB editor ─────────────
  .get("/console/kb", requireRole("admin"), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.category, a.priority, a.managed_by, a.updated_at,
         (SELECT status FROM kb_revisions r WHERE r.article_id = a.id ORDER BY created_at DESC LIMIT 1) AS last_revision,
         (SELECT COUNT(*) FROM kb_proposals p WHERE p.article_id = a.id AND p.status = 'pending') AS pending_proposals
       FROM kb_articles a ORDER BY a.id`,
    ).all();
    const indexing = await c.env.DB.prepare(
      "SELECT article_id, title, status, error FROM kb_revisions WHERE status IN ('pending','indexing','failed') AND article_id NOT IN (SELECT id FROM kb_articles) ORDER BY created_at DESC",
    ).all();
    return c.json({ articles: results, newArticles: indexing.results, nextId: await nextArticleId(c.env.DB) });
  })
  .get("/console/kb/:id", requireRole("admin"), articleId, async (c) => {
    const id = c.req.valid("param").id;
    const [article, revisions] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(id).first<ArticleRow>(),
      c.env.DB.prepare(
        `SELECT r.id, r.status, r.error, r.source, r.created_at, r.applied_at, u.name AS author FROM kb_revisions r LEFT JOIN user u ON u.id = r.author_id
         WHERE r.article_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      )
        .bind(id)
        .all(),
    ]);
    // Edit the newest saved revision (keeps {{placeholders}}), else the live body.
    const latest = await c.env.DB.prepare("SELECT * FROM kb_revisions WHERE article_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1")
      .bind(id)
      .first<ArticleRow & { article_id: string }>();
    if (!article && !latest) return c.json({ error: "not_found" }, 404);
    const draft = latest ? { ...rowMeta({ ...latest, id }), body: latest.body } : { ...rowMeta(article!), body: article!.body };
    return c.json({ article: draft, managedBy: article?.managed_by ?? "console", live: !!article, revisions: revisions.results });
  })
  .post("/console/kb/validate", requireRole("admin"), zValidator("json", articleInputSchema), (c) => {
    const v = validateArticle(c.req.valid("json"));
    return c.json(v.ok ? { ok: true, steps: v.sections.steps.length } : v);
  })
  .put("/console/kb/:id", requireRole("admin"), articleId, zValidator("json", articleInputSchema), async (c) => {
    const input = c.req.valid("json");
    if (input.id !== c.req.valid("param").id) return c.json({ ok: false, error: "id mismatch" }, 400);
    const v = validateArticle(input);
    if (!v.ok) return c.json(v, 400);
    const revisionId = await saveRevision(c.env, input, { authorId: c.get("user")!.id, source: "editor" });
    return c.json({ ok: true, revisionId });
  })

  // ───────────── knowledge-gap proposals ─────────────
  .get("/console/kb-proposals", requireRole("admin"), zValidator("query", z.object({ status: z.enum(["pending", "approved", "rejected"]).default("pending") })), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.article_id, p.kind, p.title, p.rationale, p.status, p.created_at, p.decided_at, t.number AS ticket_number, u.name AS decided_by
       FROM kb_proposals p LEFT JOIN tickets t ON t.id = p.ticket_id LEFT JOIN user u ON u.id = p.decided_by
       WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 100`,
    )
      .bind(c.req.valid("query").status)
      .all();
    return c.json({ proposals: results });
  })
  .get("/console/kb-proposals/:id", requireRole("admin"), uuidParam, async (c) => {
    const p = await c.env.DB.prepare(
      `SELECT p.*, t.number AS ticket_number, t.title AS ticket_title FROM kb_proposals p LEFT JOIN tickets t ON t.id = p.ticket_id WHERE p.id = ?`,
    )
      .bind(c.req.valid("param").id)
      .first<{ article_id: string; kind: string; meta: string | null; body: string } & Record<string, unknown>>();
    if (!p) return c.json({ error: "not_found" }, 404);
    const current = p.kind === "update" ? await c.env.DB.prepare("SELECT body FROM kb_articles WHERE id = ?").bind(p.article_id).first<{ body: string }>() : null;
    return c.json({ proposal: { ...p, meta: p.meta ? JSON.parse(p.meta) : null }, currentBody: current?.body ?? null });
  })
  .post(
    "/console/kb-proposals/:id/approve",
    requireRole("admin"),
    uuidParam,
    zValidator("json", z.object({ body: z.string().trim().min(40).max(20_000).optional() })),
    async (c) => {
      const id = c.req.valid("param").id;
      const p = await c.env.DB.prepare("SELECT * FROM kb_proposals WHERE id = ? AND status = 'pending'")
        .bind(id)
        .first<{ id: string; article_id: string; meta: string; body: string }>();
      if (!p) return c.json({ ok: false, error: "This proposal was already decided." }, 409);
      const input = { ...(JSON.parse(p.meta) as ArticleMeta), body: c.req.valid("json").body ?? p.body };
      const v = validateArticle(input);
      if (!v.ok) return c.json(v, 400);
      const user = c.get("user")!;
      // Claim it first so two admins can't both apply it.
      const claimed = await c.env.DB.prepare("UPDATE kb_proposals SET status = 'approved', decided_by = ?, decided_at = ?, body = ? WHERE id = ? AND status = 'pending' RETURNING id")
        .bind(user.id, Date.now(), input.body, id)
        .first();
      if (!claimed) return c.json({ ok: false, error: "This proposal was already decided." }, 409);
      const revisionId = await saveRevision(c.env, input, { authorId: user.id, source: "proposal", proposalId: id });
      await c.env.DB.prepare("UPDATE kb_proposals SET revision_id = ? WHERE id = ?").bind(revisionId, id).run();
      return c.json({ ok: true, revisionId });
    },
  )
  .post("/console/kb-proposals/:id/reject", requireRole("admin"), uuidParam, async (c) => {
    const r = await c.env.DB.prepare("UPDATE kb_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING id")
      .bind(c.get("user")!.id, Date.now(), c.req.valid("param").id)
      .first();
    return r ? c.json({ ok: true }) : c.json({ ok: false, error: "This proposal was already decided." }, 409);
  })

  // ───────────── analytics ─────────────
  .get("/console/analytics", requireRole("agent", "admin"), zValidator("query", z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })), async (c) => {
    return c.json(await computeAnalytics(c.env.DB, c.req.valid("query").days));
  });

export interface AgentStats {
  agent: string;
  runs: number;
  completed: number;
  errors: number;
  skipped: number;
  fallbacks: number;
  viaRules: number;
  viaLlm: number;
  avgMs: number | null;
  p95Ms: number | null;
}

export async function computeAnalytics(db: D1Database, days: number, now = Date.now()) {
  const since = now - days * 86_400_000;
  const [chats, runs, escalations, sla, openBreached, feedback, csat, perDay, routing] = await db.batch([
    db.prepare("SELECT outcome, COUNT(*) AS n FROM chat_sessions WHERE title IS NOT NULL AND created_at >= ? GROUP BY outcome").bind(since),
    db.prepare("SELECT agent, route_method, status, duration_ms FROM agent_runs WHERE created_at >= ?").bind(since),
    db.prepare("SELECT COALESCE(escalation_reason, 'unknown') AS reason, COUNT(*) AS n FROM tickets WHERE created_at >= ? GROUP BY reason ORDER BY n DESC").bind(since),
    db
      .prepare(
        `SELECT COUNT(*) AS resolved, SUM(CASE WHEN resolved_at <= sla_due_at AND sla_breached = 0 THEN 1 ELSE 0 END) AS met
         FROM tickets WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND sla_due_at IS NOT NULL`,
      )
      .bind(since),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status NOT IN ('RESOLVED','CLOSED') AND (sla_breached = 1 OR sla_due_at < ?)").bind(now),
    db.prepare("SELECT rating, COUNT(*) AS n FROM feedback WHERE created_at >= ? GROUP BY rating").bind(since),
    db.prepare("SELECT AVG(csat) AS avg, COUNT(csat) AS n FROM tickets WHERE csat IS NOT NULL AND created_at >= ?").bind(since),
    db
      .prepare(
        `SELECT day, SUM(chats) AS chats, SUM(tickets) AS tickets FROM (
           SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+5 hours', '+30 minutes') AS day, 1 AS chats, 0 AS tickets FROM chat_sessions WHERE title IS NOT NULL AND created_at >= ?1
           UNION ALL
           SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+5 hours', '+30 minutes'), 0, 1 FROM tickets WHERE created_at >= ?1
         ) GROUP BY day ORDER BY day`,
      )
      .bind(since),
    db
      .prepare("SELECT agent, route_method AS method, COUNT(*) AS n FROM agent_runs WHERE session_id IS NOT NULL AND status != 'fallback' AND created_at >= ? GROUP BY agent, route_method ORDER BY n DESC")
      .bind(since),
  ]);

  const chatRows = chats!.results as { outcome: string; n: number }[];
  const totalChats = chatRows.reduce((s, r) => s + r.n, 0);
  const resolvedChats = chatRows.find((r) => r.outcome === "resolved")?.n ?? 0;
  const escalatedChats = chatRows.find((r) => r.outcome === "escalated")?.n ?? 0;

  const byAgent = new Map<string, { rows: { method: string; status: string; ms: number | null }[] }>();
  for (const r of runs!.results as { agent: string; route_method: string; status: string; duration_ms: number | null }[]) {
    const e = byAgent.get(r.agent) ?? { rows: [] };
    e.rows.push({ method: r.route_method, status: r.status, ms: r.duration_ms });
    byAgent.set(r.agent, e);
  }
  const agents: AgentStats[] = [...byAgent.entries()]
    .map(([agent, { rows }]) => {
      const real = rows.filter((r) => r.status !== "fallback");
      const ms = real.map((r) => r.ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      return {
        agent,
        runs: real.length,
        completed: real.filter((r) => r.status === "completed").length,
        errors: real.filter((r) => r.status === "error").length,
        skipped: real.filter((r) => r.status === "skipped").length,
        fallbacks: rows.length - real.length,
        viaRules: real.filter((r) => r.method === "rules").length,
        viaLlm: real.filter((r) => r.method === "llm").length,
        avgMs: ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : null,
        p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)]! : null,
      };
    })
    .sort((a, b) => b.runs - a.runs);

  const slaRow = sla!.results[0] as { resolved: number; met: number | null };
  const fb = feedback!.results as { rating: "up" | "down"; n: number }[];
  const up = fb.find((r) => r.rating === "up")?.n ?? 0;
  const down = fb.find((r) => r.rating === "down")?.n ?? 0;
  const csatRow = csat!.results[0] as { avg: number | null; n: number };

  return {
    days,
    chats: { total: totalChats, resolved: resolvedChats, escalated: escalatedChats, resolutionRate: totalChats ? resolvedChats / totalChats : null },
    agents,
    routing: routing!.results as { agent: string; method: string; n: number }[],
    escalationReasons: escalations!.results as { reason: string; n: number }[],
    sla: { resolved: slaRow.resolved, met: slaRow.met ?? 0, metRate: slaRow.resolved ? (slaRow.met ?? 0) / slaRow.resolved : null, openBreached: (openBreached!.results[0] as { n: number }).n },
    feedback: { up, down, rate: up + down ? up / (up + down) : null },
    csat: { avg: csatRow.avg, n: csatRow.n },
    perDay: perDay!.results as { day: string; chats: number; tickets: number }[],
  };
}
export type Analytics = Awaited<ReturnType<typeof computeAnalytics>>;
