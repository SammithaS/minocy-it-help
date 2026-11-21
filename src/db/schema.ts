import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const ROLES = ["employee", "agent", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = [
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "WAITING_ON_USER",
  "RESOLVED",
  "CLOSED",
] as const;
export type TicketStatus = (typeof STATUSES)[number];

export const SOURCES = ["CHAT", "PORTAL", "EMAIL"] as const;

// ───────────── Better Auth core tables (field names match Better Auth defaults) ─────────────

export const user = sqliteTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role", { enum: ROLES }).notNull().default("employee"),
  department: text("department"),
  location: text("location"),
  /** Line manager (approves access requests). Plain id, no FK, so seeding order doesn't matter. */
  managerId: text("manager_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = sqliteTable(
  "session",
  {
    id: id(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ───────────── Org ─────────────

export const teams = sqliteTable("teams", {
  id: id(),
  name: text("name").notNull().unique(),
  mailbox: text("mailbox").notNull(),
  createdAt: createdAt(),
});

export const teamMembers = sqliteTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const devices = sqliteTable("devices", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  assetTag: text("asset_tag").notNull().unique(),
  model: text("model").notNull(),
  os: text("os", { enum: ["windows", "macos", "linux"] }).notNull(),
  createdAt: createdAt(),
});

export const routingRules = sqliteTable("routing_rules", {
  category: text("category").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  updatedAt: updatedAt(),
});

export const slaPolicies = sqliteTable("sla_policies", {
  priority: text("priority", { enum: PRIORITIES }).primaryKey(),
  /** Minutes until resolution is due. LOW uses working minutes (2 working days). */
  resolveMinutes: integer("resolve_minutes").notNull(),
  workingHoursOnly: integer("working_hours_only", { mode: "boolean" }).notNull().default(false),
  updatedAt: updatedAt(),
});

// ───────────── Knowledge base ─────────────

export const kbArticles = sqliteTable("kb_articles", {
  id: text("id").primaryKey(), // e.g. KB-002
  title: text("title").notNull(),
  category: text("category").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  os: text("os", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  ticketCategory: text("ticket_category").notNull(),
  priority: text("priority", { enum: PRIORITIES }).notNull(),
  action: text("action"),
  body: text("body").notNull(),
  contentHash: text("content_hash").notNull(),
  updatedAt: updatedAt(),
});

export const kbSteps = sqliteTable(
  "kb_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: text("article_id")
      .notNull()
      .references(() => kbArticles.id, { onDelete: "cascade" }),
    section: text("section", { enum: ["quick", "advanced"] }).notNull(),
    order: integer("order").notNull(),
    text: text("text").notNull(),
  },
  (t) => [uniqueIndex("kb_steps_article_order").on(t.articleId, t.section, t.order)],
);

// ───────────── Chat & tickets ─────────────

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    summary: text("summary"),
    outcome: text("outcome", { enum: ["open", "resolved", "escalated", "abandoned"] })
      .notNull()
      .default("open"),
    kbArticleId: text("kb_article_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_sessions_user_idx").on(t.userId)],
);

export type StepTried = { order: number; text: string; result: "worked" | "failed" | "skipped" };

export const tickets = sqliteTable(
  "tickets",
  {
    id: id(),
    number: text("number").notNull().unique(), // INC-1001
    requesterId: text("requester_id")
      .notNull()
      .references(() => user.id),
    teamId: text("team_id").references(() => teams.id),
    assigneeId: text("assignee_id").references(() => user.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    priority: text("priority", { enum: PRIORITIES }).notNull(),
    status: text("status", { enum: STATUSES }).notNull().default("NEW"),
    source: text("source", { enum: SOURCES }).notNull(),
    sessionId: text("session_id"),
    kbArticleId: text("kb_article_id"),
    stepsTried: text("steps_tried", { mode: "json" })
      .$type<StepTried[]>()
      .notNull()
      .default(sql`'[]'`),
    device: text("device"),
    slaDueAt: integer("sla_due_at", { mode: "timestamp_ms" }),
    slaBreached: integer("sla_breached", { mode: "boolean" }).notNull().default(false),
    firstResponseAt: integer("first_response_at", { mode: "timestamp_ms" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    csat: integer("csat"),
    workflowInstanceId: text("workflow_instance_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tickets_requester_idx").on(t.requesterId),
    index("tickets_team_status_idx").on(t.teamId, t.status),
  ],
);

export const ticketComments = sqliteTable(
  "ticket_comments",
  {
    id: id(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id),
    body: text("body").notNull(),
    visibility: text("visibility", { enum: ["public", "internal"] })
      .notNull()
      .default("public"),
    source: text("source", { enum: ["portal", "console", "email", "chat", "system"] })
      .notNull()
      .default("portal"),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_comments_ticket_idx").on(t.ticketId)],
);

export const ticketEvents = sqliteTable(
  "ticket_events",
  {
    id: id(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    type: text("type").notNull(), // created, assigned, status_changed, sla_reminder, escalated, ...
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId)],
);

export const notifications = sqliteTable("notifications", {
  id: id(),
  ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  channel: text("channel", { enum: ["email_team", "email_employee", "email_admin"] }).notNull(),
  /** team_new | critical_admin | employee_ack | sla_reminder | sla_escalation | resolved_confirm | reopened | comment | digest | inbound_bounce */
  kind: text("kind").notNull().default("other"),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  /** "log" = rendered and stored only (dev / no domain yet); "email-service" | "resend" = actually sent. */
  transport: text("transport").notNull().default("log"),
  status: text("status", { enum: ["sent", "logged", "failed", "skipped"] }).notNull(),
  error: text("error"),
  html: text("html"),
  text: text("text"),
  createdAt: createdAt(),
});

export const feedback = sqliteTable("feedback", {
  id: id(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  rating: text("rating", { enum: ["up", "down"] }).notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
});

export const applications = sqliteTable("applications", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description"),
  ownerTeamId: text("owner_team_id").references(() => teams.id),
  requiresManagerApproval: integer("requires_manager_approval", { mode: "boolean" })
    .notNull()
    .default(true),
  /** Other names people use ("sfdc", "finance drive"); matched before any model call. */
  aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
});

export const ACCESS_STATUSES = ["PENDING", "APPROVED", "REJECTED", "PROVISIONED", "EXPIRED"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const accessRequests = sqliteTable(
  "access_requests",
  {
    id: id(),
    /** REQ-1001 */
    number: text("number"),
    requesterId: text("requester_id")
      .notNull()
      .references(() => user.id),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id),
    justification: text("justification").notNull(),
    status: text("status", { enum: ACCESS_STATUSES }).notNull().default("PENDING"),
    approverId: text("approver_id"),
    approverEmail: text("approver_email"),
    sessionId: text("session_id"),
    decisionNote: text("decision_note"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    provisionedAt: integer("provisioned_at", { mode: "timestamp_ms" }),
    workflowInstanceId: text("workflow_instance_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("access_requests_number").on(t.number), index("access_requests_requester_idx").on(t.requesterId)],
);

/** Who has which application (the mock provisioning target). */
export const appGrants = sqliteTable(
  "app_grants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    accessRequestId: text("access_request_id"),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.applicationId] })],
);

/**
 * Mock corporate directory (stands in for Entra ID / AD): account status for self-service password
 * reset. No password is ever stored here.
 */
export const directoryAccounts = sqliteTable("directory_accounts", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  status: text("status", { enum: ["active", "locked", "disabled"] }).notNull().default("active"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
  passwordChangedAt: integer("password_changed_at", { mode: "timestamp_ms" }),
  updatedAt: updatedAt(),
});

/** One self-service password reset attempt: email code → verified → approved → link used. */
export const passwordResets = sqliteTable(
  "password_resets",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    /** HMAC of the code; the code itself is never stored. */
    codeHash: text("code_hash").notNull(),
    codeExpiresAt: integer("code_expires_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    linkUsedAt: integer("link_used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId, t.createdAt)],
);

export const auditLog = sqliteTable("audit_log", {
  id: id(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

/** Monotonic counters (e.g. ticket numbers). */
export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

/** One row per agent hand-off or back-office agent run (routing analytics, budgets, evals). */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: id(),
    sessionId: text("session_id"),
    ticketId: text("ticket_id"),
    userId: text("user_id"),
    agent: text("agent").notNull(), // knowledge | ticket | access | triage | kb_gap | supervisor
    routeMethod: text("route_method", { enum: ["rules", "llm", "workflow"] }).notNull(),
    reason: text("reason"),
    status: text("status", { enum: ["completed", "error", "aborted", "interrupted", "skipped"] }).notNull(),
    summary: text("summary"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_agent_idx").on(t.agent, t.createdAt), index("agent_runs_session_idx").on(t.sessionId)],
);
