import { cn } from "@/lib/utils";

export type TicketStatus =
  | "NEW"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "WAITING_ON_USER"
  | "RESOLVED"
  | "CLOSED";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const statusStyle: Record<TicketStatus, { label: string; cls: string }> = {
  NEW: { label: "New", cls: "bg-new-bg text-new" },
  ASSIGNED: { label: "Assigned", cls: "bg-new-bg text-new" },
  IN_PROGRESS: { label: "In progress", cls: "bg-progress-bg text-progress" },
  WAITING_ON_USER: { label: "Waiting on you", cls: "bg-progress-bg text-progress" },
  RESOLVED: { label: "Resolved", cls: "bg-resolved-bg text-resolved" },
  CLOSED: { label: "Closed", cls: "bg-canvas text-muted" },
};

const priorityStyle: Record<Priority, string> = {
  LOW: "bg-canvas text-muted",
  MEDIUM: "bg-new-bg text-new",
  HIGH: "bg-progress-bg text-progress",
  CRITICAL: "bg-critical-bg text-critical",
};

const pill = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap";

export function StatusBadge({ status, className }: { status: TicketStatus; className?: string }) {
  const s = statusStyle[status];
  return <span className={cn(pill, s.cls, className)}>{s.label}</span>;
}

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const label = priority.charAt(0) + priority.slice(1).toLowerCase();
  return <span className={cn(pill, priorityStyle[priority], className)}>{label}</span>;
}
