import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock } from "lucide-react";
import { PriorityBadge, StatusBadge } from "@/components/ui/badge";
import { CATEGORY_LABEL, isOpen, timeAgo, useSlaLabel, type Ticket } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export function SlaChip({ ticket, className }: { ticket: Pick<Ticket, "slaDueAt" | "status">; className?: string }) {
  const sla = useSlaLabel(ticket.slaDueAt, !isOpen(ticket.status));
  if (!sla) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap",
        sla.overdue ? "bg-critical-bg text-critical" : sla.soon ? "bg-progress-bg text-progress" : "bg-canvas text-muted",
        className,
      )}
    >
      <Clock className="size-3.5" /> {sla.text}
    </span>
  );
}

/** One ticket in a list (employee "My tickets" and the IT console queue). */
export function TicketRow({ ticket, staff = false, highlight = false }: { ticket: Ticket; staff?: boolean; highlight?: boolean }) {
  return (
    <Link
      to="/tickets/$number"
      params={{ number: ticket.number }}
      className={cn(
        "group flex flex-col gap-2 rounded-tile border bg-card p-4 transition-colors hover:border-control sm:flex-row sm:items-center",
        highlight ? "border-sun ring-2 ring-sun/40" : "border-line",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-muted">{ticket.number}</span>
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          {staff && <SlaChip ticket={ticket} />}
        </div>
        <p className="mt-1 truncate text-[15px] font-bold">{ticket.title}</p>
        <p className="mt-0.5 text-[13px] text-muted">
          {staff ? `${ticket.requester.name ?? "Unknown"} · ` : ""}
          {ticket.team?.name ?? CATEGORY_LABEL[ticket.category] ?? ticket.category} · updated {timeAgo(ticket.updatedAt)}
          {ticket.source === "CHAT" ? " · from chat" : ""}
        </p>
      </div>
      <ArrowRight className="hidden size-4 shrink-0 text-muted group-hover:text-brand-700 sm:block" />
    </Link>
  );
}
