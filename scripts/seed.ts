/**
 * Generates `.wrangler/seed.sql` with dummy org data; `pnpm db:seed` then applies it to local D1.
 *
 * Team mailboxes: set SEED_MAILBOX_TEMPLATE to an address you own with a `{team}` placeholder,
 * e.g. `you+it-{team}@gmail.com`, so the mailboxes can be verified in Email Routing later.
 * Defaults to `it-{team}@minocy.example` (not deliverable).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { org, TEAMS } from "../src/org-config";

const mailboxTemplate = process.env.SEED_MAILBOX_TEMPLATE ?? `it-{team}@${org.emailDomain}`;
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? `admin@${org.emailDomain}`;

type Role = "employee" | "agent" | "admin";
interface SeedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  department: string;
  location: string;
  teams?: string[];
  /** Line manager (approves access requests). */
  manager?: string;
  device?: { assetTag: string; model: string; os: "windows" | "macos" | "linux" };
}

const at = (local: string) => `${local}@${org.emailDomain}`;

const users: SeedUser[] = [
  { id: "u-admin", name: "Kavya Rao", email: adminEmail, role: "admin", department: "IT", location: "Bengaluru", teams: TEAMS.map((t) => t.id) },
  { id: "u-sammitha", name: "Sammitha S Poojary", email: "owner@example.com", role: "admin", department: "IT", location: "Bengaluru", teams: TEAMS.map((t) => t.id) },
  { id: "u-agent-net", name: "Arjun Mehta", email: at("arjun.mehta"), role: "agent", department: "IT", location: "Bengaluru", teams: ["team-network"] },
  { id: "u-agent-hw", name: "Priya Nair", email: at("priya.nair"), role: "agent", department: "IT", location: "Pune", teams: ["team-hardware"] },
  { id: "u-agent-sw", name: "Rahul Verma", email: at("rahul.verma"), role: "agent", department: "IT", location: "Bengaluru", teams: ["team-software"] },
  { id: "u-agent-iam", name: "Sneha Iyer", email: at("sneha.iyer"), role: "agent", department: "IT", location: "Hyderabad", teams: ["team-identity"] },
  { id: "u-agent-col", name: "Vikram Singh", email: at("vikram.singh"), role: "agent", department: "IT", location: "Pune", teams: ["team-collab", "team-software"] },
  // Line managers (employees too) — they approve access requests by email.
  { id: "u-mgr-fin", name: "Deepa Menon", email: at("deepa.menon"), role: "employee", department: "Finance", location: "Bengaluru" },
  { id: "u-mgr-gtm", name: "Nikhil Bose", email: at("nikhil.bose"), role: "employee", department: "Sales", location: "Mumbai" },
  { id: "u-mgr-prd", name: "Lakshmi Pillai", email: at("lakshmi.pillai"), role: "employee", department: "Engineering", location: "Pune" },
  { id: "u-emp-1", name: "Ananya Sharma", email: at("ananya.sharma"), role: "employee", department: "Finance", location: "Bengaluru", manager: "u-mgr-fin", device: { assetTag: "MIN-LT-0141", model: "Dell Latitude 7440", os: "windows" } },
  { id: "u-emp-2", name: "Rohan Das", email: at("rohan.das"), role: "employee", department: "Sales", location: "Mumbai", manager: "u-mgr-gtm", device: { assetTag: "MIN-LT-0152", model: "Lenovo ThinkPad T14", os: "windows" } },
  { id: "u-emp-3", name: "Meera Krishnan", email: at("meera.krishnan"), role: "employee", department: "Design", location: "Bengaluru", manager: "u-mgr-prd", device: { assetTag: "MIN-MB-0033", model: "MacBook Pro 14 M3", os: "macos" } },
  { id: "u-emp-4", name: "Aditya Kulkarni", email: at("aditya.kulkarni"), role: "employee", department: "Engineering", location: "Pune", manager: "u-mgr-prd", device: { assetTag: "MIN-LT-0207", model: "Lenovo ThinkPad X1 Carbon", os: "linux" } },
  { id: "u-emp-5", name: "Fatima Sheikh", email: at("fatima.sheikh"), role: "employee", department: "HR", location: "Hyderabad", manager: "u-mgr-fin", device: { assetTag: "MIN-LT-0118", model: "HP EliteBook 840", os: "windows" } },
  { id: "u-emp-6", name: "Karthik Reddy", email: at("karthik.reddy"), role: "employee", department: "Engineering", location: "Hyderabad", manager: "u-mgr-prd", device: { assetTag: "MIN-MB-0047", model: "MacBook Air 13 M2", os: "macos" } },
  { id: "u-emp-7", name: "Neha Gupta", email: at("neha.gupta"), role: "employee", department: "Marketing", location: "Mumbai", manager: "u-mgr-gtm", device: { assetTag: "MIN-LT-0163", model: "Dell Latitude 5440", os: "windows" } },
  { id: "u-emp-8", name: "Siddharth Joshi", email: at("siddharth.joshi"), role: "employee", department: "Operations", location: "Pune", manager: "u-mgr-fin", device: { assetTag: "MIN-LT-0189", model: "HP EliteBook 640", os: "windows" } },
];

const slaPolicies = [
  { priority: "CRITICAL", minutes: 60, working: false },
  { priority: "HIGH", minutes: 4 * 60, working: false },
  { priority: "MEDIUM", minutes: 8 * 60, working: false },
  { priority: "LOW", minutes: 2 * 9 * 60, working: true }, // 2 working days of 9 h
];

const applications = [
  { id: "app-figma", name: "Figma", team: "team-software", desc: "Design and prototyping", aliases: ["figjam"] },
  { id: "app-jira", name: "Jira", team: "team-software", desc: "Issue tracking", aliases: ["jira software"] },
  { id: "app-salesforce", name: "Salesforce", team: "team-identity", desc: "CRM", aliases: ["sfdc", "crm"] },
  { id: "app-tally", name: "Tally Prime", team: "team-software", desc: "Accounting", aliases: ["tally"] },
  { id: "app-shared-finance", name: "Finance shared drive", team: "team-identity", desc: "\\\\files\\finance", aliases: ["finance drive", "finance share", "finance folder"] },
  { id: "app-github", name: "GitHub Enterprise", team: "team-identity", desc: "Source control", aliases: ["github", "git hub"] },
];

/** Access people already have (so "I need Figma" from a designer is answered without a request). */
const grants: [user: string, app: string][] = [
  ["u-emp-3", "app-figma"],
  ["u-emp-4", "app-github"],
  ["u-emp-4", "app-jira"],
  ["u-emp-6", "app-github"],
  ["u-emp-1", "app-tally"],
];

/** Mock directory: one locked account to demo self-service unlock. */
const lockedAccounts = new Set(["u-emp-2"]);

const q = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replace(/'/g, "''")}'`;
};

const now = Date.now();
const sql: string[] = [
  "-- Generated by scripts/seed.ts — dummy data only",
  // Existing tickets/requests reference teams, users and apps that are deleted and re-inserted with
  // the same ids below; check foreign keys at the end instead of per statement.
  "PRAGMA defer_foreign_keys = on;",
  "DELETE FROM team_members; DELETE FROM devices; DELETE FROM routing_rules; DELETE FROM sla_policies;",
  "DELETE FROM app_grants; DELETE FROM access_requests; DELETE FROM applications; DELETE FROM teams;",
  "DELETE FROM password_resets; DELETE FROM directory_accounts;",
  "DELETE FROM session; DELETE FROM account; DELETE FROM verification;",
];

for (const t of TEAMS) {
  const mailbox = mailboxTemplate.replace("{team}", t.category);
  sql.push(`INSERT INTO teams (id, name, mailbox, created_at) VALUES (${q(t.id)}, ${q(t.name)}, ${q(mailbox)}, ${now});`);
  sql.push(`INSERT INTO routing_rules (category, team_id, updated_at) VALUES (${q(t.category)}, ${q(t.id)}, ${now});`);
}

for (const s of slaPolicies) {
  sql.push(
    `INSERT INTO sla_policies (priority, resolve_minutes, working_hours_only, updated_at) VALUES (${q(s.priority)}, ${s.minutes}, ${q(s.working)}, ${now});`,
  );
}

for (const u of users) {
  sql.push(
    `INSERT INTO user (id, name, email, email_verified, role, department, location, manager_id, created_at, updated_at) VALUES (${q(u.id)}, ${q(u.name)}, ${q(u.email.toLowerCase())}, 1, ${q(u.role)}, ${q(u.department)}, ${q(u.location)}, ${q(u.manager)}, ${now}, ${now})
ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, role=excluded.role, department=excluded.department, location=excluded.location, manager_id=excluded.manager_id, updated_at=excluded.updated_at;`,
  );
  const locked = lockedAccounts.has(u.id);
  sql.push(
    `INSERT INTO directory_accounts (user_id, username, status, must_change_password, locked_at, updated_at) VALUES (${q(u.id)}, ${q(u.email.split("@")[0]!.toLowerCase())}, ${q(locked ? "locked" : "active")}, 0, ${locked ? now : "NULL"}, ${now});`,
  );
  for (const teamId of u.teams ?? []) {
    sql.push(`INSERT INTO team_members (team_id, user_id) VALUES (${q(teamId)}, ${q(u.id)});`);
  }
  if (u.device) {
    sql.push(
      `INSERT INTO devices (id, user_id, asset_tag, model, os, created_at) VALUES (${q(`dev-${u.id}`)}, ${q(u.id)}, ${q(u.device.assetTag)}, ${q(u.device.model)}, ${q(u.device.os)}, ${now});`,
    );
  }
}

for (const a of applications) {
  sql.push(
    `INSERT INTO applications (id, name, description, owner_team_id, requires_manager_approval, aliases) VALUES (${q(a.id)}, ${q(a.name)}, ${q(a.desc)}, ${q(a.team)}, 1, ${q(JSON.stringify(a.aliases))});`,
  );
}
for (const [userId, appId] of grants) {
  sql.push(`INSERT INTO app_grants (user_id, application_id, created_at) VALUES (${q(userId)}, ${q(appId)}, ${now});`);
}

sql.push(`INSERT INTO counters (name, value) VALUES ('ticket', 1000) ON CONFLICT(name) DO NOTHING;`);
sql.push(`INSERT INTO counters (name, value) VALUES ('access', 1000) ON CONFLICT(name) DO NOTHING;`);

mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/seed.sql", sql.join("\n") + "\n");
console.log(`Wrote .wrangler/seed.sql (${users.length} users, ${TEAMS.length} teams)`);
console.log("Sign in with e.g.", users.find((u) => u.role === "employee" && u.device)!.email, "(employee),", users[1]!.email, "(agent),", adminEmail, "(admin)");
