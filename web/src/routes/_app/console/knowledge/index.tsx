import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowRight, FilePlus2, Lightbulb, Loader2 } from "lucide-react";
import { z } from "zod";
import { PriorityBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { kbListQuery, proposalsQuery, type ProposalSummary, type RevisionStatus } from "@/lib/console";
import { timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/knowledge/")({
  validateSearch: z.object({ tab: z.enum(["proposals", "articles"]).default("proposals"), status: z.enum(["pending", "approved", "rejected"]).default("pending") }),
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: KnowledgePage,
});

export const REVISION_LABEL: Record<RevisionStatus, { text: string; tone: string }> = {
  pending: { text: "Queued", tone: "bg-progress-bg text-progress" },
  indexing: { text: "Re-indexing…", tone: "bg-progress-bg text-progress" },
  live: { text: "Live", tone: "bg-resolved-bg text-resolved" },
  failed: { text: "Failed", tone: "bg-critical-bg text-critical" },
  superseded: { text: "Older", tone: "bg-canvas text-muted" },
};

function KnowledgePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: pending = [] } = useQuery(proposalsQuery("pending"));
  const tab = (active: boolean) => cn("min-h-10 rounded-full px-4 text-sm font-semibold", active ? "bg-brand-50 text-brand-800" : "text-muted hover:text-ink");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Knowledge base</h1>
          <p className="text-sm text-muted">Edit guides, and review what the Knowledge-gap agent learned from resolved tickets.</p>
        </div>
        <Link
          to="/console/knowledge/$id"
          params={{ id: "new" }}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand-700 px-5 text-sm font-bold text-on-brand"
        >
          <FilePlus2 className="size-4" /> New guide
        </Link>
      </div>
      <div className="flex w-fit gap-1 rounded-full border border-line bg-card p-1">
        <button type="button" className={tab(search.tab === "proposals")} onClick={() => void navigate({ search: { ...search, tab: "proposals" } })}>
          Proposals{pending.length ? ` (${pending.length})` : ""}
        </button>
        <button type="button" className={tab(search.tab === "articles")} onClick={() => void navigate({ search: { ...search, tab: "articles" } })}>
          Guides
        </button>
      </div>
      {search.tab === "proposals" ? <Proposals status={search.status} onStatus={(s) => void navigate({ search: { ...search, status: s } })} /> : <Articles />}
    </div>
  );
}

function Proposals({ status, onStatus }: { status: ProposalSummary["status"]; onStatus: (s: ProposalSummary["status"]) => void }) {
  const { data = [], isPending } = useQuery(proposalsQuery(status));
  return (
    <div className="space-y-3">
      <div className="flex gap-3 text-sm">
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <button key={s} type="button" onClick={() => onStatus(s)} className={cn("min-h-9 font-semibold capitalize", s === status ? "text-brand-800 underline underline-offset-4" : "text-muted")}>
            {s}
          </button>
        ))}
      </div>
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : data.length === 0 ? (
        <Card className="flex items-center gap-3">
          <Lightbulb className="size-6 shrink-0 text-muted" />
          <p className="text-sm text-muted">
            {status === "pending" ? "Nothing to review. When a resolved ticket shows a gap in the guides, the agent's proposal appears here." : `No ${status} proposals.`}
          </p>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {data.map((p) => (
            <li key={p.id}>
              <Link to="/console/knowledge/proposals/$id" params={{ id: p.id }} className="group flex items-center gap-3 rounded-tile border border-line bg-card p-4 hover:border-control">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sun-50 text-[#0369A1] dark:text-sun">
                  <Lightbulb className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-xs font-bold text-muted">
                    <span className={cn("rounded-full px-2 py-0.5", p.kind === "new" ? "bg-brand-50 text-brand-800" : "bg-canvas")}>{p.kind === "new" ? "New guide" : `Update ${p.article_id}`}</span>
                    {p.ticket_number && <span>from {p.ticket_number}</span>}
                    <span>· {timeAgo(p.created_at)}</span>
                    {p.decided_by && <span>· {p.status} by {p.decided_by}</span>}
                  </span>
                  <span className="mt-1 block truncate font-bold">{p.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{p.rationale}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted group-hover:text-brand-700" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Articles() {
  const { data, isPending } = useQuery({ ...kbListQuery, refetchInterval: (q) => (q.state.data?.articles.some((a) => a.last_revision === "pending" || a.last_revision === "indexing") || q.state.data?.newArticles.length ? 3000 : false) });
  if (isPending || !data) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-3">
      {data.newArticles.map((n) => (
        <Card key={n.article_id} className="flex items-center gap-3 text-sm">
          <Loader2 className={cn("size-4", n.status !== "failed" && "animate-spin")} />
          <span className="font-bold">{n.article_id}</span> {n.title}
          <span className={cn("ml-auto rounded-full px-2.5 py-1 text-xs font-bold", REVISION_LABEL[n.status].tone)}>{REVISION_LABEL[n.status].text}</span>
        </Card>
      ))}
      <div className="overflow-x-auto rounded-card border border-line bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs font-bold tracking-wide text-muted uppercase">
            <tr className="border-b border-line">
              <th className="px-4 py-3">Guide</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3">
                <span className="sr-only">Status</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.articles.map((a) => (
              <tr key={a.id} className="hover:bg-canvas">
                <td className="px-4 py-3">
                  <Link to="/console/knowledge/$id" params={{ id: a.id }} className="font-bold text-ink hover:text-brand-700">
                    <span className="text-muted">{a.id}</span> {a.title}
                  </Link>
                  <span className="block text-xs text-muted">{a.category}</span>
                </td>
                <td className="px-4 py-3">
                  <PriorityBadge priority={a.priority} />
                </td>
                <td className="px-4 py-3 text-muted">{a.managed_by === "console" ? "Console" : "kb/*.md"}</td>
                <td className="px-4 py-3 text-muted">{timeAgo(a.updated_at)}</td>
                <td className="px-4 py-3 text-right">
                  {a.last_revision && a.last_revision !== "live" && a.last_revision !== "superseded" && (
                    <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", REVISION_LABEL[a.last_revision].tone)}>{REVISION_LABEL[a.last_revision].text}</span>
                  )}
                  {a.pending_proposals > 0 && <span className="ml-2 rounded-full bg-sun-50 px-2.5 py-1 text-xs font-bold text-[#0369A1] dark:text-sun">{a.pending_proposals} proposal</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
