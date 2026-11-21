import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { BellRing, Inbox, Plug, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { TicketRow } from "@/components/tickets/ticket-row";
import { PriorityBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { queueQuery } from "@/lib/console";
import { useBoardFeed, type BoardMessage } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/")({
  validateSearch: z.object({
    scope: z.enum(["mine", "all"]).default("mine"),
    status: z.enum(["open", "all", "NEW", "ASSIGNED", "IN_PROGRESS", "WAITING_ON_USER", "RESOLVED", "CLOSED"]).default("open"),
    team: z.string().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    assigned: z.enum(["any", "me", "unassigned"]).default("any"),
    sla: z.enum(["any", "overdue", "soon"]).default("any"),
    q: z.string().max(100).optional(),
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
  const { data, isPending } = useQuery(queueQuery(search));
  const [text, setText] = useState(search.q ?? "");
  // Search as you type, debounced.
  useEffect(() => {
    const id = setTimeout(() => {
      if ((search.q ?? "") !== text.trim()) void navigate({ search: { ...search, q: text.trim() || undefined }, replace: true });
    }, 300);
    return () => clearTimeout(id);
  }, [text, search, navigate]);
  const filtersOn = !!(search.priority || search.assigned !== "any" || search.sla !== "any" || search.q || (search.status !== "open" && search.status !== "all"));
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
        <div className="flex items-center gap-3 text-sm">
          <Link to="/console/connect" className="hidden min-h-11 items-center gap-1.5 rounded-full px-3 font-bold text-brand-700 hover:bg-brand-50 sm:inline-flex">
            <Plug className="size-4" /> Connect Claude
          </Link>
          <Stat label={search.status === "open" ? "Open" : "Shown"} value={tickets.length} />
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

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Search tickets</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search number, title or requester"
            className="min-h-11 w-full rounded-full border border-control bg-card pr-4 pl-9 text-sm text-ink placeholder:text-muted focus:border-brand-700 focus:outline-none"
          />
        </label>
        <FilterSelect
          label="Priority"
          value={search.priority ?? ""}
          onChange={(v) => void navigate({ search: { ...search, priority: (v || undefined) as typeof search.priority } })}
          options={[["", "Any priority"], ["CRITICAL", "Critical"], ["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"]]}
        />
        <FilterSelect
          label="Assigned"
          value={search.assigned}
          onChange={(v) => void navigate({ search: { ...search, assigned: v as typeof search.assigned } })}
          options={[["any", "Anyone"], ["me", "Assigned to me"], ["unassigned", "Unassigned"]]}
        />
        <FilterSelect
          label="SLA"
          value={search.sla}
          onChange={(v) => void navigate({ search: { ...search, sla: v as typeof search.sla } })}
          options={[["any", "Any SLA"], ["overdue", "Overdue"], ["soon", "Due in 2 h"]]}
        />
        <FilterSelect
          label="Status"
          value={search.status}
          onChange={(v) => void navigate({ search: { ...search, status: v as typeof search.status } })}
          options={[["open", "All open"], ["NEW", "New"], ["ASSIGNED", "Assigned"], ["IN_PROGRESS", "In progress"], ["WAITING_ON_USER", "Waiting on user"], ["RESOLVED", "Resolved"], ["CLOSED", "Closed"], ["all", "Everything"]]}
        />
        {filtersOn && (
          <button
            type="button"
            onClick={() => {
              setText("");
              void navigate({ search: { scope: search.scope, team: search.team, status: "open", assigned: "any", sla: "any" } });
            }}
            className="min-h-11 px-3 text-sm font-bold text-brand-700"
          >
            Clear filters
          </button>
        )}
      </div>

      {isPending ? (
        <p className="text-sm text-muted">Loading queue…</p>
      ) : tickets.length === 0 ? (
        <Card className="flex items-center gap-3">
          <Inbox className="size-6 text-muted" />
          <p className="text-sm text-muted">{filtersOn ? "No tickets match these filters." : "Queue is clear. New tickets will appear here instantly."}</p>
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

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const active = value !== options[0]![0];
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "min-h-11 rounded-full border bg-card px-3.5 text-sm font-semibold focus:border-brand-700 focus:outline-none",
          active ? "border-brand-700 text-brand-800" : "border-control text-ink",
        )}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
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
