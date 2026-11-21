/**
 * IT Ops MCP server — lets IT staff work the queue from Claude (Desktop / Code) or an IDE.
 *
 *   POST /mcp   Authorization: Bearer mit_…   (a personal access token from the console)
 *
 * Stateless Streamable HTTP (agents/mcp/server `createMcpHandler`, MCP SDK v2): every request builds
 * a fresh server for the token's owner, so tools are scoped to that person's teams (admins: all).
 * Tools are deterministic DB reads/writes — no model calls.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { PRIORITIES } from "../db/schema";
import type { AppEnv } from "../env";
import { notifyBoard } from "../lib/tickets";

export interface McpUser {
  id: string;
  name: string;
  role: "agent" | "admin";
}

// ───────────────────────────── tokens ─────────────────────────────

const enc = new TextEncoder();
export async function hashToken(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** New token: `mit_` + 32 random bytes (base64url). Returned once; only the hash is stored. */
export async function createApiToken(env: AppEnv, userId: string, name: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `mit_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, name, await hashToken(token), token.slice(0, 8), Date.now())
    .run();
  return { id, token };
}

/** Bearer token → active IT staff member, or null. Records last use. */
export async function authenticateToken(env: AppEnv, header: string | null): Promise<McpUser | null> {
  const token = header?.match(/^Bearer\s+(mit_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, u.id, u.name, u.role FROM api_tokens t JOIN user u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.role IN ('agent','admin')`,
  )
    .bind(await hashToken(token))
    .first<{ token_id: string; id: string; name: string; role: "agent" | "admin" }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.token_id).run();
  return { id: row.id, name: row.name, role: row.role };
}

// ───────────────────────────── tools ─────────────────────────────

const STATUS_FILTER = z.enum(["open", "all", "NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_ON_USER", "RESOLVED", "CLOSED"]);
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/** Tickets this user may see: their teams' tickets (admins: every ticket). */
function scope(user: McpUser): { sql: string; binds: unknown[] } {
  return user.role === "admin" ? { sql: "1 = 1", binds: [] } : { sql: "t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)", binds: [user.id] };
}

export function buildItOpsServer(env: AppEnv, user: McpUser): McpServer {
  const server = new McpServer({ name: "minocy-itops", version: "1.0.0" });
  const db = env.DB;

  server.registerTool(
    "listMyTeamTickets",
    {
      title: "List my team's tickets",
      description:
        "List tickets in the IT teams you belong to (all teams for admins), most urgent first. Defaults to open tickets. Use getTicket for details.",
      inputSchema: z.object({
        status: STATUS_FILTER.default("open").describe("'open' (default), 'all', or one status"),
        priority: z.enum(PRIORITIES).optional(),
        overdueOnly: z.boolean().default(false).describe("Only open tickets past their SLA"),
        assignedToMe: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, priority, overdueOnly, assignedToMe, limit }) => {
      const s = scope(user);
      const where = [s.sql];
      const binds = [...s.binds];
      if (status === "open") where.push("t.status NOT IN ('RESOLVED','CLOSED')");
      else if (status !== "all") {
        where.push("t.status = ?");
        binds.push(status);
      }
      if (priority) {
        where.push("t.priority = ?");
        binds.push(priority);
      }
      if (overdueOnly) {
        where.push("t.status NOT IN ('RESOLVED','CLOSED') AND (t.sla_breached = 1 OR t.sla_due_at < ?)");
        binds.push(Date.now());
      }
      if (assignedToMe) {
        where.push("t.assignee_id = ?");
        binds.push(user.id);
      }
      const { results } = await db
        .prepare(
          `SELECT t.number, t.title, t.status, t.priority, t.sla_due_at, t.sla_breached, tm.name AS team, a.name AS assignee, r.name AS requester, t.updated_at
           FROM tickets t LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN user a ON a.id = t.assignee_id JOIN user r ON r.id = t.requester_id
           WHERE ${where.join(" AND ")}
           ORDER BY CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.sla_due_at LIMIT ?`,
        )
        .bind(...binds, limit)
        .all<{ number: string; title: string; status: string; priority: string; sla_due_at: number | null; sla_breached: number; team: string | null; assignee: string | null; requester: string; updated_at: number }>();
      const now = Date.now();
      return text({
        count: results.length,
        tickets: results.map((t) => ({
          number: t.number,
          title: t.title,
          status: t.status,
          priority: t.priority,
          team: t.team,
          assignee: t.assignee,
          requester: t.requester,
          slaDueAt: fmt(t.sla_due_at),
          overdue: !!t.sla_breached || (t.sla_due_at !== null && t.sla_due_at < now && !["RESOLVED", "CLOSED"].includes(t.status)),
        })),
      });
    },
  );

  server.registerTool(
    "getTicket",
    {
      title: "Get a ticket",
      description: "Full details of one ticket: description, steps already tried with the assistant, device, SLA, the triage agent's note, and the comment history (public and internal).",
      inputSchema: z.object({ number: z.string().regex(/^INC-?\d+$/i).describe("e.g. INC-1031") }),
      annotations: { readOnlyHint: true },
    },
    async ({ number }) => {
      const s = scope(user);
      const n = number.toUpperCase().replace(/^INC(\d)/, "INC-$1");
      const t = await db
        .prepare(
          `SELECT t.*, tm.name AS team, a.name AS assignee, r.name AS requester, r.email AS requester_email
           FROM tickets t LEFT JOIN teams tm ON tm.id = t.team_id LEFT JOIN user a ON a.id = t.assignee_id JOIN user r ON r.id = t.requester_id
           WHERE t.number = ? AND ${s.sql}`,
        )
        .bind(n, ...s.binds)
        .first<Record<string, unknown> & { id: string; steps_tried: string }>();
      if (!t) return { ...text(`No ticket ${n} in your teams.`), isError: true };
      const { results: comments } = await db
        .prepare(
          `SELECT c.body, c.visibility, c.source, c.created_at, u.name AS author FROM ticket_comments c LEFT JOIN user u ON u.id = c.author_id
           WHERE c.ticket_id = ? ORDER BY c.created_at`,
        )
        .bind(t.id)
        .all<{ body: string; visibility: string; source: string; created_at: number; author: string | null }>();
      return text({
        number: t.number,
        title: t.title,
        status: t.status,
        priority: t.priority,
        category: t.category,
        team: t.team,
        assignee: t.assignee,
        requester: `${t.requester} <${t.requester_email}>`,
        source: t.source,
        device: t.device,
        guideFollowed: t.kb_article_id,
        description: t.description,
        stepsTried: JSON.parse(t.steps_tried || "[]"),
        slaDueAt: fmt(t.sla_due_at as number | null),
        slaBreached: !!t.sla_breached,
        createdAt: fmt(t.created_at as number),
        url: `${env.APP_URL}/tickets/${t.number}`,
        comments: comments.map((c) => ({
          at: fmt(c.created_at),
          by: c.author ?? (c.source === "system" ? "Triage agent" : "System"),
          visibility: c.visibility,
          body: c.body,
        })),
      });
    },
  );

  server.registerTool(
    "addInternalNote",
    {
      title: "Add an internal note",
      description: "Add an internal note (IT only — the employee never sees it) to a ticket in your teams. Use for findings, next steps or hand-over notes.",
      inputSchema: z.object({
        number: z.string().regex(/^INC-?\d+$/i),
        note: z.string().trim().min(2).max(4000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ number, note }) => {
      const s = scope(user);
      const n = number.toUpperCase().replace(/^INC(\d)/, "INC-$1");
      const t = await db
        .prepare(`SELECT t.id, t.number, t.team_id FROM tickets t WHERE t.number = ? AND ${s.sql}`)
        .bind(n, ...s.binds)
        .first<{ id: string; number: string; team_id: string | null }>();
      if (!t) return { ...text(`No ticket ${n} in your teams.`), isError: true };
      const now = Date.now();
      await db.batch([
        db
          .prepare("INSERT INTO ticket_comments (id, ticket_id, author_id, body, visibility, source, created_at) VALUES (?, ?, ?, ?, 'internal', 'mcp', ?)")
          .bind(crypto.randomUUID(), t.id, user.id, note, now),
        db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(now, t.id),
        db
          .prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, data, created_at) VALUES (?, ?, 'ticket.internal_note', 'ticket', ?, ?, ?)")
          .bind(crypto.randomUUID(), user.id, t.id, JSON.stringify({ via: "mcp" }), now),
      ]);
      await notifyBoard(env, { type: "ticket.updated", ticketId: t.id, number: t.number, teamId: t.team_id, changes: { comment: "internal" } });
      return text(`Added an internal note to ${t.number} as ${user.name}.`);
    },
  );

  return server;
}

/** Worker entry for /mcp: authenticate, then serve the request statelessly. */
export async function handleMcp(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const user = await authenticateToken(env, request.headers.get("Authorization"));
  if (!user) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: send 'Authorization: Bearer <token>' with an IT Help access token (Console → Connect Claude)." } },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="minocy-itops"' } },
    );
  }
  const handler = createMcpHandler(() => buildItOpsServer(env, user), {
    route: "/mcp",
    corsOptions: false,
    allowedHostnames: [new URL(env.APP_URL).hostname, "localhost", "127.0.0.1"],
  });
  return handler(request, env, ctx);
}
