import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { PRIORITIES } from "../db/schema";
import { TICKET_CATEGORIES } from "../org-config";
import {
  assignTicket,
  confirmResolution,
  getTicketByNumber,
  markFirstResponse,
  reopenClosedOrStale,
  resolveTicket,
  setTicketStatus,
} from "../lib/ticket-actions";
import { createTicket, notifyBoard, STAFF_ROLES, type TicketRow } from "../lib/tickets";
import { requireRole, type HonoEnv } from "./context";

const numberParam = zValidator("param", z.object({ number: z.string().regex(/^INC-\d+$/) }));

/** Public shape of a ticket (camelCase, parsed JSON). */
export function serializeTicket(t: TicketRow & { team_name?: string | null; requester_name?: string | null; assignee_name?: string | null }) {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: t.status,
    source: t.source,
    team: t.team_id ? { id: t.team_id, name: t.team_name ?? null } : null,
    requester: { id: t.requester_id, name: t.requester_name ?? null },
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name ?? null } : null,
    sessionId: t.session_id,
    kbArticleId: t.kb_article_id,
    stepsTried: JSON.parse(t.steps_tried || "[]") as { order: number; text: string; result: string }[],
    device: t.device,
    slaDueAt: t.sla_due_at,
    slaBreached: !!t.sla_breached,
    firstResponseAt: t.first_response_at,
    resolvedAt: t.resolved_at,
    closedAt: t.closed_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

const TICKET_SELECT = `SELECT t.*, tm.name AS team_name, r.name AS requester_name, a.name AS assignee_name
  FROM tickets t LEFT JOIN teams tm ON tm.id = t.team_id
  JOIN user r ON r.id = t.requester_id LEFT JOIN user a ON a.id = t.assignee_id`;

export const ticketRoutes = new Hono<HonoEnv>()
  .use("/tickets", requireRole())
  .use("/tickets/*", requireRole())
  // Employee's own tickets.
  .get("/tickets", async (c) => {
    const { results } = await c.env.DB.prepare(`${TICKET_SELECT} WHERE t.requester_id = ? ORDER BY t.created_at DESC LIMIT 100`)
      .bind(c.get("user")!.id)
      .all<TicketRow>();
    return c.json({ tickets: results.map(serializeTicket) });
  })
  // Raise a ticket from the portal form (the chat uses the Ticket agent instead).
  .post(
    "/tickets",
    zValidator(
      "json",
      z.object({
        title: z.string().trim().min(5).max(120),
        description: z.string().trim().min(10).max(4000),
        category: z.enum(TICKET_CATEGORIES),
        priority: z.enum(PRIORITIES).exclude(["CRITICAL"]).default("MEDIUM"),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const user = c.get("user")!;
      const device = await c.env.DB.prepare("SELECT model, os, asset_tag FROM devices WHERE user_id = ?")
        .bind(user.id)
        .first<{ model: string; os: string; asset_tag: string }>();
      const t = await createTicket(c.env, {
        requesterId: user.id,
        ...body,
        source: "PORTAL",
        device: device ? `${device.model} (${device.os}, ${device.asset_tag})` : null,
      });
      return c.json({ ticket: t }, 201);
    },
  )
  .get("/tickets/:number", numberParam, async (c) => {
    const user = c.get("user")!;
    const staff = STAFF_ROLES.has(user.role as string);
    const t = await c.env.DB.prepare(`${TICKET_SELECT} WHERE t.number = ?`).bind(c.req.valid("param").number).first<TicketRow>();
    if (!t || (!staff && t.requester_id !== user.id)) return c.json({ error: "not_found" }, 404);
    const [comments, events] = await Promise.all([
      c.env.DB.prepare(
        `SELECT c.id, c.body, c.visibility, c.source, c.created_at, u.name AS author_name, u.role AS author_role, c.author_id
         FROM ticket_comments c LEFT JOIN user u ON u.id = c.author_id
         WHERE c.ticket_id = ? ${staff ? "" : "AND c.visibility = 'public'"} ORDER BY c.created_at`,
      )
        .bind(t.id)
        .all(),
      c.env.DB.prepare("SELECT type, data, created_at FROM ticket_events WHERE ticket_id = ? ORDER BY created_at").bind(t.id).all(),
    ]);
    return c.json({
      ticket: serializeTicket(t),
      comments: comments.results,
      events: events.results.map((e) => ({ ...e, data: e.data ? JSON.parse(String(e.data)) : null })),
    });
  })
  .post(
    "/tickets/:number/comments",
    numberParam,
    zValidator("json", z.object({ body: z.string().trim().min(1).max(4000), visibility: z.enum(["public", "internal"]).default("public") })),
    async (c) => {
      const user = c.get("user")!;
      const staff = STAFF_ROLES.has(user.role as string);
      const { body, visibility } = c.req.valid("json");
      const t = await c.env.DB.prepare("SELECT id, number, requester_id, team_id, status, first_response_at FROM tickets WHERE number = ?")
        .bind(c.req.valid("param").number)
        .first<Pick<TicketRow, "id" | "number" | "requester_id" | "team_id" | "status" | "first_response_at">>();
      if (!t || (!staff && t.requester_id !== user.id)) return c.json({ error: "not_found" }, 404);
      const vis = staff ? visibility : "public";
      const now = Date.now();
      const stmts = [
        c.env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          t.id,
          user.id,
          body,
          vis,
          staff ? "console" : "portal",
          now,
        ),
        c.env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(now, t.id),
      ];
      await c.env.DB.batch(stmts);
      // A public staff reply is the first response for SLA purposes (stops the workflow's SLA clock).
      if (staff && vis === "public") {
        const full = await getTicketByNumber(c.env, t.number);
        if (full) await markFirstResponse(c.env, full);
      }
      await notifyBoard(c.env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { comment: vis } });
      return c.json({ ok: true }, 201);
    },
  )
  // "Did this fix it?" from the portal (email links use /api/public/confirm).
  .post(
    "/tickets/:number/confirm",
    numberParam,
    zValidator("json", z.object({ answer: z.enum(["yes", "no"]), reason: z.string().trim().max(1000).optional() })),
    async (c) => {
      const t = await getTicketByNumber(c.env, c.req.valid("param").number);
      if (!t || t.requester_id !== c.get("user")!.id) return c.json({ error: "not_found" }, 404);
      if (t.status !== "RESOLVED") return c.json({ error: "not_resolved" }, 409);
      const { answer, reason } = c.req.valid("json");
      return c.json({ ok: true, result: await confirmResolution(c.env, t, answer, reason) });
    },
  )
  .post("/tickets/:number/reopen", numberParam, zValidator("json", z.object({ reason: z.string().trim().min(3).max(1000) })), async (c) => {
    const t = await getTicketByNumber(c.env, c.req.valid("param").number);
    if (!t || t.requester_id !== c.get("user")!.id) return c.json({ error: "not_found" }, 404);
    if (t.status !== "RESOLVED" && t.status !== "CLOSED") return c.json({ error: "not_resolved" }, 409);
    const { reason } = c.req.valid("json");
    if (t.status === "RESOLVED") await confirmResolution(c.env, t, "no", reason);
    else await reopenClosedOrStale(c.env, t, reason);
    const after = await getTicketByNumber(c.env, t.number);
    return c.json({ ok: true, status: after?.status ?? "NEW" });
  });

export const consoleRoutes = new Hono<HonoEnv>()
  .use("/console/*", requireRole("agent", "admin"))
  // Queue: my teams' tickets by default; admins can see everything.
  .get(
    "/console/tickets",
    zValidator(
      "query",
      z.object({ scope: z.enum(["mine", "all"]).default("mine"), status: z.enum(["open", "all"]).default("open"), team: z.string().optional() }),
    ),
    async (c) => {
      const user = c.get("user")!;
      const { scope, status, team } = c.req.valid("query");
      const where: string[] = [];
      const binds: unknown[] = [];
      if (status === "open") where.push("t.status NOT IN ('RESOLVED', 'CLOSED')");
      if (team) {
        where.push("t.team_id = ?");
        binds.push(team);
      } else if (scope === "mine" || user.role !== "admin") {
        where.push("t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)");
        binds.push(user.id);
      }
      const { results } = await c.env.DB.prepare(
        `${TICKET_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.sla_due_at LIMIT 200`,
      )
        .bind(...binds)
        .all<TicketRow>();
      const teams = await c.env.DB.prepare(
        user.role === "admin"
          ? "SELECT id, name FROM teams ORDER BY name"
          : "SELECT t.id, t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name",
      )
        .bind(...(user.role === "admin" ? [] : [user.id]))
        .all<{ id: string; name: string }>();
      return c.json({ tickets: results.map(serializeTicket), teams: teams.results });
    },
  )
  // ── ticket actions (each also signals the ticket's workflow) ──
  .post(
    "/console/tickets/:number/assign",
    numberParam,
    zValidator("json", z.object({ assigneeId: z.string().optional() })),
    async (c) => {
      const user = c.get("user")!;
      const t = await getTicketByNumber(c.env, c.req.valid("param").number);
      if (!t || !(await canWork(c.env.DB, user, t.team_id))) return c.json({ error: "not_found" }, 404);
      const assigneeId = c.req.valid("json").assigneeId ?? user.id;
      const member = await c.env.DB.prepare("SELECT 1 FROM user WHERE id = ? AND role IN ('agent','admin')").bind(assigneeId).first();
      if (!member) return c.json({ error: "invalid_assignee" }, 400);
      await assignTicket(c.env, t, assigneeId, user.id);
      return c.json({ ok: true });
    },
  )
  .post(
    "/console/tickets/:number/status",
    numberParam,
    zValidator("json", z.object({ status: z.enum(["IN_PROGRESS", "WAITING_ON_USER"]) })),
    async (c) => {
      const user = c.get("user")!;
      const t = await getTicketByNumber(c.env, c.req.valid("param").number);
      if (!t || !(await canWork(c.env.DB, user, t.team_id))) return c.json({ error: "not_found" }, 404);
      if (t.status === "RESOLVED" || t.status === "CLOSED") return c.json({ error: "closed" }, 409);
      await setTicketStatus(c.env, t, c.req.valid("json").status, user.id);
      return c.json({ ok: true });
    },
  )
  .post(
    "/console/tickets/:number/resolve",
    numberParam,
    zValidator("json", z.object({ note: z.string().trim().min(3).max(2000) })),
    async (c) => {
      const user = c.get("user")!;
      const t = await getTicketByNumber(c.env, c.req.valid("param").number);
      if (!t || !(await canWork(c.env.DB, user, t.team_id))) return c.json({ error: "not_found" }, 404);
      if (t.status === "RESOLVED" || t.status === "CLOSED") return c.json({ error: "already_resolved" }, 409);
      await resolveTicket(c.env, t, c.req.valid("json").note, user.id);
      return c.json({ ok: true });
    },
  )
  // ── Outbox: every email the system rendered (log transport) or sent (live) ──
  .get("/console/outbox", requireRole("admin"), async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.kind, n.channel, n.recipient, n.subject, n.transport, n.status, n.error, n.created_at, t.number AS ticket_number
       FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id ORDER BY n.created_at DESC LIMIT 200`,
    ).all();
    return c.json({ emails: results });
  })
  .get("/console/outbox/:id", requireRole("admin"), async (c) => {
    const row = await c.env.DB.prepare("SELECT html FROM notifications WHERE id = ?").bind(c.req.param("id")).first<{ html: string | null }>();
    if (!row?.html) return c.text("Not found", 404);
    // Rendered email shown in a sandboxed iframe in the console; no scripts allowed.
    return c.html(row.html, 200, { "Content-Security-Policy": "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src *" });
  })
  // Live queue updates (WebSocket) from the TicketBoard Durable Object.
  .get("/console/live", (c) => {
    if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "expected_websocket" }, 426);
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-user-id", c.get("user")!.id);
    return c.env.TICKET_BOARD.getByName("board").fetch(new Request(c.req.raw, { headers }));
  });

/** Staff can work a ticket in one of their teams; admins can work any ticket. */
async function canWork(db: D1Database, user: { id: string; role?: unknown }, teamId: string | null) {
  if (user.role === "admin") return true;
  if (!teamId) return false;
  return !!(await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, user.id).first());
}
