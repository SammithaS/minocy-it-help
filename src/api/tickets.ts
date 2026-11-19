import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { PRIORITIES } from "../db/schema";
import { TICKET_CATEGORIES } from "../org-config";
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
      // A public staff reply is the first response for SLA purposes.
      if (staff && vis === "public" && !t.first_response_at) {
        stmts.push(c.env.DB.prepare("UPDATE tickets SET first_response_at = ? WHERE id = ?").bind(now, t.id));
      }
      await c.env.DB.batch(stmts);
      await notifyBoard(c.env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { comment: vis } });
      return c.json({ ok: true }, 201);
    },
  )
  .post("/tickets/:number/reopen", numberParam, zValidator("json", z.object({ reason: z.string().trim().min(3).max(1000) })), async (c) => {
    const user = c.get("user")!;
    const t = await c.env.DB.prepare("SELECT id, number, requester_id, team_id, status, assignee_id FROM tickets WHERE number = ?")
      .bind(c.req.valid("param").number)
      .first<Pick<TicketRow, "id" | "number" | "requester_id" | "team_id" | "status" | "assignee_id">>();
    if (!t || t.requester_id !== user.id) return c.json({ error: "not_found" }, 404);
    if (t.status !== "RESOLVED" && t.status !== "CLOSED") return c.json({ error: "not_resolved" }, 409);
    const status = t.assignee_id ? "ASSIGNED" : "NEW";
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tickets SET status = ?, resolved_at = NULL, closed_at = NULL, updated_at = ? WHERE id = ?").bind(status, now, t.id),
      c.env.DB.prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'public', 'portal', ?)").bind(
        crypto.randomUUID(),
        t.id,
        user.id,
        `Reopened: ${c.req.valid("json").reason}`,
        now,
      ),
      c.env.DB.prepare("INSERT INTO ticket_events (id, ticket_id, actor_id, type, data, created_at) VALUES (?, ?, ?, 'reopened', ?, ?)").bind(
        crypto.randomUUID(),
        t.id,
        user.id,
        JSON.stringify({ from: t.status, to: status }),
        now,
      ),
    ]);
    await notifyBoard(c.env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { status } });
    return c.json({ ok: true, status });
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
  // Live queue updates (WebSocket) from the TicketBoard Durable Object.
  .get("/console/live", (c) => {
    if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "expected_websocket" }, 426);
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-user-id", c.get("user")!.id);
    return c.env.TICKET_BOARD.getByName("board").fetch(new Request(c.req.raw, { headers }));
  });
