import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { BellRing, Inbox, X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { TicketRow } from "@/components/tickets/ticket-row";
import { PriorityBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { consoleQueueQuery, useBoardFeed, type BoardMessage } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/")({
  validateSearch: z.object({
    scope: z.enum(["mine", "all"]).default("mine"),
    status: z.enum(["open", "all"]).default("open"),
    team: z.string().optional(),
  }),
  component: Console,
});

interface Toast {
  id: number;
  number: string;
  title: string;
  priority: NonNullable<BoardMessage["ticket"]>["priority"];
  team: string;
}

function Console() {
  const { me } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isPending } = useQuery(consoleQueueQuery(search));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const isAdmin = me.user.role === "admin";
  const myTeams = new Set(me.teams.map((t) => t.id));

  const live = useBoardFeed((m) => {
    if (m.type !== "ticket.created" || !m.ticket) return;
    const relevant = isAdmin || (m.ticket.teamId && myTeams.has(m.ticket.teamId));
    if (!relevant) return;
    const toast = { id: Date.now(), number: m.ticket.number, title: m.ticket.title, priority: m.ticket.priority, team: m.ticket.team?.name ?? "Unrouted" };
    setToasts((t) => [toast, ...t].slice(0, 3));
    setFresh((f) => new Set(f).add(m.ticket!.number));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 8000);
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const tickets = data?.tickets ?? [];
  const breached = tickets.filter((t) => t.slaBreached || (t.slaDueAt !== null && t.slaDueAt < now)).length;

  const pill = (active: boolean) =>
    cn("min-h-9 rounded-full px-3.5 text-sm font-semibold transition-colors", active ? "bg-brand-50 text-brand-800" : "text-muted hover:text-ink");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">IT console</h1>
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className={cn("size-2 rounded-full", live ? "bg-[#22C55E]" : "bg-control")} aria-hidden />
            {live ? "Live" : "Connecting…"} · {me.user.name} ({isAdmin ? "IT Admin" : "IT Agent"})
            {me.teams.length > 0 && ` · ${me.teams.map((t) => t.name).join(", ")}`}
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Stat label="Open" value={tickets.length} />
          <Stat label="Overdue" value={breached} tone={breached ? "critical" : undefined} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 rounded-card border border-line bg-card p-1.5">
        <button type="button" className={pill(search.scope === "mine" && !search.team)} onClick={() => void navigate({ search: { ...search, scope: "mine", team: undefined } })}>
          My teams
        </button>
        {isAdmin && (
          <button type="button" className={pill(search.scope === "all" && !search.team)} onClick={() => void navigate({ search: { ...search, scope: "all", team: undefined } })}>
            All teams
          </button>
        )}
        {(data?.teams ?? []).map((t) => (
          <button key={t.id} type="button" className={pill(search.team === t.id)} onClick={() => void navigate({ search: { ...search, team: t.id } })}>
            {t.name}
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-line" />
        <button type="button" className={pill(search.status === "open")} onClick={() => void navigate({ search: { ...search, status: "open" } })}>
          Open
        </button>
        <button type="button" className={pill(search.status === "all")} onClick={() => void navigate({ search: { ...search, status: "all" } })}>
          All
        </button>
      </div>

      {isPending ? (
        <p className="text-sm text-muted">Loading queue…</p>
      ) : tickets.length === 0 ? (
        <Card className="flex items-center gap-3">
          <Inbox className="size-6 text-muted" />
          <p className="text-sm text-muted">Queue is clear. New tickets will appear here instantly.</p>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>
            {tickets.map((t) => (
              <motion.li key={t.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <TicketRow ticket={t} staff highlight={fresh.has(t.number)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {/* New-ticket toasts */}
      <div className="pointer-events-none fixed right-4 bottom-20 z-40 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 md:bottom-6" aria-live="assertive">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-ink-surface p-4 text-white shadow-chat"
            >
              <BellRing className="mt-0.5 size-5 shrink-0 text-sun" />
              <Link to="/tickets/$number" params={{ number: t.number }} className="min-w-0 flex-1">
                <p className="text-sm font-bold">
                  New ticket {t.number} · {t.team}
                </p>
                <p className="truncate text-sm text-white/80">{t.title}</p>
                <PriorityBadge priority={t.priority} className="mt-1.5" />
              </Link>
              <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="grid size-8 place-items-center rounded-full hover:bg-white/10">
                <X className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" }) {
  return (
    <div className={cn("rounded-2xl border px-4 py-2 text-center", tone === "critical" ? "border-critical/30 bg-critical-bg text-critical" : "border-line bg-card")}>
      <p className="text-xl font-extrabold leading-none">{value}</p>
      <p className="mt-1 text-xs font-semibold">{label}</p>
    </div>
  );
}
