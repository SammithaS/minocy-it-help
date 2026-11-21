import { queryOptions } from "@tanstack/react-query";
import type { Priority } from "@/components/ui/badge";
import { apiFetch } from "./api";
import type { Ticket } from "./tickets";

// ───────────── queue ─────────────

export interface QueueParams {
  scope: "mine" | "all";
  status: "open" | "all" | "NEW" | "ASSIGNED" | "IN_PROGRESS" | "WAITING_ON_USER" | "RESOLVED" | "CLOSED";
  team?: string;
  priority?: Priority;
  assigned: "any" | "me" | "unassigned";
  sla: "any" | "overdue" | "soon";
  q?: string;
}

export const queueQuery = (p: QueueParams) =>
  queryOptions({
    queryKey: ["console", "queue", p],
    queryFn: () => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") q.set(k, String(v));
      return apiFetch<{ tickets: Ticket[]; teams: { id: string; name: string }[] }>(`/console/tickets?${q}`);
    },
    staleTime: 30_000,
  });

// ───────────── ticket detail (staff) ─────────────

export interface TranscriptItem {
  role: "user" | "assistant" | "system";
  kind: "text" | "handoff" | "step" | "card";
  text: string;
  outcome?: string;
  note?: string;
}

export const transcriptQuery = (number: string) =>
  queryOptions({
    queryKey: ["console", "transcript", number],
    queryFn: () => apiFetch<{ transcript: TranscriptItem[] | null }>(`/console/tickets/${number}/transcript`).then((r) => r.transcript),
    staleTime: 60_000,
  });

export const assigneesQuery = (number: string) =>
  queryOptions({
    queryKey: ["console", "assignees", number],
    queryFn: () => apiFetch<{ assignees: { id: string; name: string; role: string; open: number }[] }>(`/console/tickets/${number}/assignees`).then((r) => r.assignees),
    staleTime: 60_000,
  });

// ───────────── settings ─────────────

export interface Settings {
  categories: string[];
  teams: { id: string; name: string; mailbox: string }[];
  routing: { category: string; team_id: string }[];
  sla: { priority: Priority; minutes: number; workingHoursOnly: boolean }[];
}
export const settingsQuery = queryOptions({ queryKey: ["console", "settings"], queryFn: () => apiFetch<Settings>("/console/settings") });

// ───────────── knowledge base ─────────────

export interface KbArticleSummary {
  id: string;
  title: string;
  category: string;
  priority: Priority;
  managed_by: "file" | "console";
  updated_at: number;
  last_revision: RevisionStatus | null;
  pending_proposals: number;
}
export type RevisionStatus = "pending" | "indexing" | "live" | "failed" | "superseded";

export interface ArticleDraft {
  id: string;
  title: string;
  category: string;
  tags: string[];
  os: ("windows" | "macos" | "linux")[];
  ticket_category: string;
  priority: Priority;
  action: "troubleshoot" | "how_to" | "password_reset" | "access_request";
  body: string;
}

export interface Revision {
  id: string;
  status: RevisionStatus;
  error: string | null;
  source: "editor" | "proposal";
  created_at: number;
  applied_at: number | null;
  author: string | null;
}

export const kbListQuery = queryOptions({
  queryKey: ["console", "kb"],
  queryFn: () =>
    apiFetch<{ articles: KbArticleSummary[]; newArticles: { article_id: string; title: string; status: RevisionStatus; error: string | null }[]; nextId: string }>("/console/kb"),
});

export const kbArticleQuery = (id: string) =>
  queryOptions({
    queryKey: ["console", "kb", id],
    queryFn: () => apiFetch<{ article: ArticleDraft; managedBy: "file" | "console"; live: boolean; revisions: Revision[] }>(`/console/kb/${id}`),
  });

export interface ProposalSummary {
  id: string;
  article_id: string;
  kind: "update" | "new";
  title: string;
  rationale: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  decided_at: number | null;
  ticket_number: string | null;
  decided_by: string | null;
}

export const proposalsQuery = (status: ProposalSummary["status"]) =>
  queryOptions({
    queryKey: ["console", "kb-proposals", status],
    queryFn: () => apiFetch<{ proposals: ProposalSummary[] }>(`/console/kb-proposals?status=${status}`).then((r) => r.proposals),
  });

export const proposalQuery = (id: string) =>
  queryOptions({
    queryKey: ["console", "kb-proposal", id],
    queryFn: () =>
      apiFetch<{ proposal: ProposalSummary & { body: string; meta: Omit<ArticleDraft, "body"> | null; ticket_title: string | null; revision_id: string | null }; currentBody: string | null }>(
        `/console/kb-proposals/${id}`,
      ),
  });

// ───────────── analytics ─────────────

export interface Analytics {
  days: number;
  chats: { total: number; resolved: number; escalated: number; resolutionRate: number | null };
  agents: { agent: string; runs: number; completed: number; errors: number; skipped: number; fallbacks: number; viaRules: number; viaLlm: number; avgMs: number | null; p95Ms: number | null }[];
  routing: { agent: string; method: string; n: number }[];
  escalationReasons: { reason: string; n: number }[];
  sla: { resolved: number; met: number; metRate: number | null; openBreached: number };
  feedback: { up: number; down: number; rate: number | null };
  csat: { avg: number | null; n: number };
  perDay: { day: string; chats: number; tickets: number }[];
}
export const analyticsQuery = (days: number) =>
  queryOptions({ queryKey: ["console", "analytics", days], queryFn: () => apiFetch<Analytics>(`/console/analytics?days=${days}`), staleTime: 60_000 });

/** Minimal line diff (LCS) for the proposal review: unchanged / added / removed lines. */
export function lineDiff(before: string, after: string): { type: "same" | "add" | "del"; text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { type: "same" | "add" | "del"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: "del", text: a[i++]! });
    else out.push({ type: "add", text: b[j++]! });
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

/** Keeps changed lines plus `context` lines around them; long unchanged runs become one "skip" row. */
export function collapseDiff(lines: ReturnType<typeof lineDiff>, context = 2): ({ type: "same" | "add" | "del"; text: string } | { type: "skip"; count: number })[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: ({ type: "same" | "add" | "del"; text: string } | { type: "skip"; count: number })[] = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    out.push({ type: "skip", count: j - i });
    i = j;
  }
  return out;
}

export const ESCALATION_LABEL: Record<string, string> = {
  user_requested: "Asked for IT",
  not_satisfied: "Fix didn't hold",
  all_steps_tried: "All steps tried",
  escalate_condition: "Guide said escalate",
  failed_high_priority: "High priority, still broken",
  frustration: "Frustration",
  no_article: "No guide",
  safety: "Safety",
  self_service_failed: "Self-service failed",
  portal: "Portal form",
  email: "Email",
  unknown: "Unknown",
};

export const AGENT_NAME: Record<string, string> = {
  knowledge: "Knowledge",
  ticket: "Ticket",
  access: "Access",
  password: "Password reset",
  status: "Ticket status",
  chat: "Assistant",
  supervisor: "Supervisor",
  triage: "Triage",
  kb_gap: "Knowledge gap",
  followup: "24 h follow-up",
};
