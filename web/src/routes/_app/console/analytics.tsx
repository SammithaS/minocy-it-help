import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { AGENT_NAME, analyticsQuery, ESCALATION_LABEL, type Analytics } from "@/lib/console";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/analytics")({
  validateSearch: z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }),
  component: AnalyticsPage,
});

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ms = (x: number | null) => (x === null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x} ms`);

function AnalyticsPage() {
  const { days } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isPending, isError } = useQuery(analyticsQuery(days));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Analytics</h1>
          <p className="text-sm text-muted">How the assistant and its agents are doing, and how fast IT closes the rest.</p>
        </div>
        <div className="flex gap-1 rounded-full border border-line bg-card p-1" role="group" aria-label="Time range">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === days}
              onClick={() => void navigate({ search: { days: d } })}
              className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", d === days ? "bg-brand-50 text-brand-800" : "text-muted hover:text-ink")}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {isError && <Card className="text-sm text-critical">Couldn&apos;t load analytics.</Card>}
      {isPending || !data ? <p className="text-sm text-muted">Loading…</p> : <Dashboard a={data} />}
    </div>
  );
}

function Dashboard({ a }: { a: Analytics }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Solved by the assistant" value={pct(a.chats.resolutionRate)} note={`${a.chats.resolved} of ${a.chats.total} chats · ${a.chats.escalated} became tickets`} />
        <Tile label="SLA met" value={pct(a.sla.metRate)} note={`${a.sla.met} of ${a.sla.resolved} resolved tickets`} />
        <Tile label="Open & overdue" value={String(a.sla.openBreached)} note="right now" tone={a.sla.openBreached ? "critical" : undefined} />
        <Tile
          label="Helpful (👍)"
          value={pct(a.feedback.rate)}
          note={`${a.feedback.up} 👍 · ${a.feedback.down} 👎${a.csat.n ? ` · CSAT ${a.csat.avg?.toFixed(1)}/5 (${a.csat.n})` : ""}`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle>Chats per day</CardTitle>
          <DayBars rows={fillDays(a.perDay, a.days)} k="chats" unit="chat" />
        </Card>
        <Card>
          <CardTitle>Tickets per day</CardTitle>
          <DayBars rows={fillDays(a.perDay, a.days)} k="tickets" unit="ticket" />
        </Card>
      </div>

      <Card>
        <CardTitle>Agents</CardTitle>
        <CardDescription className="mt-1">Runs in this period. &quot;Fallbacks&quot; = Gemini failed and Workers AI answered; &quot;skipped&quot; = budget or nothing to do.</CardDescription>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs font-bold tracking-wide text-muted uppercase">
              <tr className="border-b border-line">
                <th className="py-2 pr-3">Agent</th>
                <th className="px-3 py-2 text-right">Runs</th>
                <th className="px-3 py-2 text-right">OK</th>
                <th className="px-3 py-2 text-right">Errors</th>
                <th className="px-3 py-2 text-right">Skipped</th>
                <th className="px-3 py-2 text-right">Fallbacks</th>
                <th className="px-3 py-2 text-right">By rule / AI</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="py-2 pl-3 text-right">p95</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {a.agents.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-4 text-muted">
                    No agent runs yet.
                  </td>
                </tr>
              )}
              {a.agents.map((r) => (
                <tr key={r.agent}>
                  <td className="py-2.5 pr-3 font-semibold">{AGENT_NAME[r.agent] ?? r.agent}</td>
                  <td className="px-3 py-2.5 text-right">{r.runs}</td>
                  <td className="px-3 py-2.5 text-right">{r.completed}</td>
                  <td className={cn("px-3 py-2.5 text-right", r.errors && "font-bold text-critical")}>{r.errors}</td>
                  <td className="px-3 py-2.5 text-right">{r.skipped}</td>
                  <td className={cn("px-3 py-2.5 text-right", r.fallbacks && "font-bold text-progress")}>{r.fallbacks}</td>
                  <td className="px-3 py-2.5 text-right text-muted">
                    {r.viaRules} / {r.viaLlm}
                  </td>
                  <td className="px-3 py-2.5 text-right">{ms(r.avgMs)}</td>
                  <td className="py-2.5 pl-3 text-right">{ms(r.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle>Why tickets were raised</CardTitle>
          <CardDescription className="mt-1">The assistant&apos;s escalation reason, or the channel for portal and email tickets.</CardDescription>
          <HBars rows={a.escalationReasons.map((r) => ({ label: ESCALATION_LABEL[r.reason] ?? r.reason, n: r.n }))} />
        </Card>
        <Card>
          <CardTitle>Routing mix</CardTitle>
          <CardDescription className="mt-1">Chat hand-offs by specialist — decided by a rule (free) or by the supervisor model.</CardDescription>
          <HBars rows={mergeRouting(a.routing)} />
        </Card>
      </div>
    </>
  );
}

/** One row per day (IST) across the whole range, zeros included, so bars sit on a true time axis. */
function fillDays(rows: Analytics["perDay"], days: number): Analytics["perDay"] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const out: Analytics["perDay"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = ist(Date.now() - i * 86_400_000);
    out.push(byDay.get(day) ?? { day, chats: 0, tickets: 0 });
  }
  return out;
}

function mergeRouting(rows: Analytics["routing"]) {
  const m = new Map<string, { rules: number; llm: number }>();
  for (const r of rows) {
    const e = m.get(r.agent) ?? { rules: 0, llm: 0 };
    if (r.method === "llm") e.llm += r.n;
    else e.rules += r.n;
    m.set(r.agent, e);
  }
  return [...m.entries()]
    .map(([agent, e]) => ({ label: AGENT_NAME[agent] ?? agent, n: e.rules + e.llm, note: `${e.rules} rule · ${e.llm} AI` }))
    .sort((x, y) => y.n - x.n);
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "critical" }) {
  return (
    <div className={cn("rounded-card border p-4", tone === "critical" ? "border-critical/30 bg-critical-bg" : "border-line bg-card")}>
      <p className="text-xs font-bold tracking-wide text-muted uppercase">{label}</p>
      <p className={cn("mt-1 text-3xl font-extrabold tabular-nums", tone === "critical" ? "text-critical" : "text-ink")}>{value}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}

/** Single-series column chart, one bar per day (IST), hover for the value. */
function DayBars({ rows, k, unit }: { rows: Analytics["perDay"]; k: "chats" | "tickets"; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r[k]));
  if (!rows.length) return <p className="mt-4 text-sm text-muted">Nothing in this period.</p>;
  const label = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return (
    <figure className="mt-4">
      <div className="relative h-36 border-b border-line">
        <span className="absolute -top-1 left-0 text-[11px] text-muted tabular-nums">{max}</span>
        <div className="absolute inset-x-0 top-1.5 border-t border-dashed border-line" aria-hidden />
        <div className="absolute inset-0 flex items-end gap-0.5 pl-6">
          {rows.map((r) => (
            <div key={r.day} className="group relative flex h-full min-w-0 flex-1 items-end justify-center">
              <div className="w-full max-w-6 rounded-t bg-brand-700 transition-opacity group-hover:opacity-80" style={{ height: `${Math.max(r[k] ? 4 : 0, (r[k] / max) * 100)}%` }} />
              <span className="pointer-events-none absolute bottom-full mb-1 hidden rounded-lg bg-ink-surface px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
                {label(r.day)}: {r[k]} {unit}
                {r[k] === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-1.5 flex justify-between pl-6 text-[11px] text-muted">
        <span>{label(rows[0]!.day)}</span>
        <span>{label(rows.at(-1)!.day)}</span>
      </figcaption>
      <table className="sr-only">
        <caption>
          {unit}s per day
        </caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <th>{r.day}</th>
              <td>{r[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Single-series horizontal bars with direct value labels (short lists). */
function HBars({ rows }: { rows: { label: string; n: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="mt-4 text-sm text-muted">Nothing in this period.</p>;
  return (
    <ul className="mt-4 space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm" title={r.note}>
          <span className="truncate text-ink">{r.label}</span>
          <span className="h-3 rounded-r bg-canvas">
            <span className="block h-full rounded-r bg-brand-700" style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }} />
          </span>
          <span className="w-24 text-right font-semibold tabular-nums">
            {r.n}
            {r.note && <span className="block text-[11px] font-normal text-muted">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
