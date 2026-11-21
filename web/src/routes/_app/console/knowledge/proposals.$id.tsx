import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft, Check, Lightbulb, Loader2, Pencil, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch, ApiError } from "@/lib/api";
import { collapseDiff, lineDiff, proposalQuery } from "@/lib/console";
import { timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/knowledge/proposals/$id")({
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: ProposalPage,
});

/** Review a Knowledge-gap proposal: why, the diff against the live guide, approve (optionally edited) or reject. */
function ProposalPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { data, isPending } = useQuery(proposalQuery(id));
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["console"] });
  const approve = useMutation({
    mutationFn: () => apiFetch(`/console/kb-proposals/${id}/approve`, { method: "POST", body: JSON.stringify(body && body !== data?.proposal.body ? { body } : {}) }),
    onSuccess: refresh,
  });
  const reject = useMutation({ mutationFn: () => apiFetch(`/console/kb-proposals/${id}/reject`, { method: "POST", body: "{}" }), onSuccess: refresh });

  if (isPending || !data) return <p className="text-sm text-muted">Loading…</p>;
  const p = data.proposal;
  const proposed = body ?? p.body;
  const raw = data.currentBody ? lineDiff(data.currentBody, proposed) : null;
  const diff = raw && !full ? collapseDiff(raw) : raw;
  const changed = raw ? raw.filter((l) => l.type !== "same").length : 0;
  const decided = p.status !== "pending";
  const err = approve.error ?? reject.error;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to="/console/knowledge" search={{ tab: "proposals", status: "pending" }} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
        <ArrowLeft className="size-4" /> Proposals
      </Link>

      <header className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-muted">
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs", p.kind === "new" ? "bg-brand-50 text-brand-800" : "bg-canvas")}>{p.kind === "new" ? `New guide ${p.article_id}` : `Update ${p.article_id}`}</span>
          {p.ticket_number && (
            <Link to="/tickets/$number" params={{ number: p.ticket_number }} className="text-brand-700">
              from {p.ticket_number}
            </Link>
          )}
          <span>· {timeAgo(p.created_at)}</span>
        </p>
        <h1 className="text-2xl font-extrabold">{p.title}</h1>
      </header>

      <Card className="flex gap-3 border-sun bg-sun-50/60 dark:bg-transparent">
        <Lightbulb className="mt-0.5 size-5 shrink-0 text-[#0369A1] dark:text-sun" />
        <div>
          <p className="text-xs font-bold tracking-wide text-muted uppercase">Why the Knowledge-gap agent suggests this</p>
          <p className="mt-1 text-[15px]">{p.rationale}</p>
          {p.ticket_title && <p className="mt-1 text-sm text-muted">Ticket: {p.ticket_title}</p>}
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">
            {diff ? "Changes to the live guide" : "Proposed guide"}
            {raw && <span className="ml-2 text-sm font-normal text-muted">{changed} line{changed === 1 ? "" : "s"} changed</span>}
          </h2>
          {raw && !editing && (
            <button type="button" onClick={() => setFull((f) => !f)} className="ml-auto min-h-11 px-2 text-sm font-bold text-brand-700">
              {full ? "Only changes" : "Whole guide"}
            </button>
          )}
          {!decided && (
            <Button variant="outline" onClick={() => setEditing((e) => !e)}>
              <Pencil /> {editing ? "Show changes" : "Edit before approving"}
            </Button>
          )}
        </div>
        {editing ? (
          <textarea
            value={proposed}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[420px] w-full rounded-xl border border-control bg-card px-3 py-2 font-mono text-[13px] leading-relaxed focus:border-brand-700 focus:outline-none"
            aria-label="Proposed guide"
          />
        ) : (
          <pre className="max-h-[560px] overflow-auto rounded-xl border border-line bg-canvas p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
            {(diff ?? proposed.split("\n").map((text) => ({ type: "add" as const, text }))).map((l, i) =>
              l.type === "skip" ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => setFull(true)}
                  className="-mx-3 block w-[calc(100%+1.5rem)] bg-card px-3 py-1 text-left text-xs font-semibold text-muted hover:text-ink"
                >
                  ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
                </button>
              ) : (
              <div
                key={i}
                className={cn(
                  "-mx-3 px-3",
                  diff && l.type === "add" && "bg-resolved-bg text-resolved",
                  diff && l.type === "del" && "bg-critical-bg text-critical line-through decoration-critical/40",
                )}
              >
                <span aria-hidden className="mr-2 inline-block w-3 select-none text-muted">
                  {diff ? (l.type === "add" ? "+" : l.type === "del" ? "−" : " ") : ""}
                </span>
                <span className="sr-only">{diff ? (l.type === "add" ? "added: " : l.type === "del" ? "removed: " : "") : ""}</span>
                {l.text || " "}
              </div>
              ),
            )}
          </pre>
        )}
      </Card>

      {decided ? (
        <Card>
          <p className="font-bold">
            {p.status === "approved" ? "Approved" : "Rejected"}
            {p.decided_by ? ` by ${p.decided_by}` : ""}
            {p.decided_at ? ` · ${timeAgo(p.decided_at)}` : ""}
          </p>
          {p.status === "approved" && (
            <Link to="/console/knowledge/$id" params={{ id: p.article_id }} className="mt-1 inline-block text-sm font-bold text-brand-700">
              See re-index status
            </Link>
          )}
        </Card>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => approve.mutate()} disabled={approve.isPending || reject.isPending}>
            {approve.isPending ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; publish
          </Button>
          <Button variant="outline" onClick={() => reject.mutate()} disabled={approve.isPending || reject.isPending}>
            <X /> Reject
          </Button>
          {err && (
            <p role="alert" className="text-sm text-critical">
              {err instanceof ApiError && err.status === 409 ? "Someone already decided this one." : err instanceof ApiError && err.status === 400 ? "That version doesn't follow the guide format." : "That didn't work — try again."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
