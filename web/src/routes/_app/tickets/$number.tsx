import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Lock, MessageSquare, RotateCcw, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { InlineMd } from "@/components/inline-md";
import { SlaChip } from "@/components/tickets/ticket-row";
import { PriorityBadge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch, ApiError, isStaff } from "@/lib/api";
import { CATEGORY_LABEL, isOpen, ticketQuery, timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/tickets/$number")({
  params: { parse: (p) => ({ number: p.number.toUpperCase() }), stringify: (p) => p },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(ticketQuery(params.number)),
  errorComponent: ({ error }) => (
    <Card>
      <p className="font-bold">{error instanceof ApiError && error.status === 404 ? "Ticket not found" : "Couldn't load this ticket"}</p>
      <Link to="/tickets" className="mt-2 inline-block text-sm font-bold text-brand-700">
        Back to my tickets
      </Link>
    </Card>
  ),
  component: TicketPage,
});

const EVENT_LABEL: Record<string, string> = {
  created: "Ticket raised",
  assigned: "Assigned",
  status_changed: "Status changed",
  reopened: "Reopened",
  resolved: "Resolved",
  closed: "Closed",
  sla_reminder: "SLA reminder sent",
  escalated: "Escalated",
};

function TicketPage() {
  const { number } = Route.useParams();
  const { me } = Route.useRouteContext();
  const staff = isStaff(me.user.role);
  const { data } = useSuspenseQuery(ticketQuery(number));
  const { ticket: t, comments, events } = data;
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [showReopen, setShowReopen] = useState(false);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["tickets"] }), qc.invalidateQueries({ queryKey: ["console"] })]);
  const comment = useMutation({
    mutationFn: () => apiFetch(`/tickets/${number}/comments`, { method: "POST", body: JSON.stringify({ body, visibility: internal ? "internal" : "public" }) }),
    onSuccess: async () => {
      setBody("");
      await refresh();
    },
  });
  const reopen = useMutation({
    mutationFn: () => apiFetch(`/tickets/${number}/reopen`, { method: "POST", body: JSON.stringify({ reason: reopenReason }) }),
    onSuccess: async () => {
      setShowReopen(false);
      setReopenReason("");
      await refresh();
    },
  });

  // One timeline: events + comments, oldest first.
  const timeline = [
    ...events.map((e) => ({ kind: "event" as const, at: e.created_at, e })),
    ...comments.map((c) => ({ kind: "comment" as const, at: c.created_at, c })),
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to={staff ? "/console" : "/tickets"} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
        <ArrowLeft className="size-4" /> {staff ? "Console" : "My tickets"}
      </Link>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-muted">{t.number}</span>
          <StatusBadge status={t.status} />
          <PriorityBadge priority={t.priority} />
          <SlaChip ticket={t} />
        </div>
        <h1 className="mt-2 text-2xl font-extrabold leading-tight">{t.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {t.team?.name ?? CATEGORY_LABEL[t.category]} · raised {timeAgo(t.createdAt)} {t.source === "CHAT" ? "from chat" : t.source === "EMAIL" ? "by email" : "in the portal"}
          {staff && t.requester.name ? ` by ${t.requester.name}` : ""}
          {t.assignee?.name ? ` · assigned to ${t.assignee.name}` : ""}
        </p>
      </header>

      <Card className="space-y-4">
        <p className="whitespace-pre-line text-[15px] leading-relaxed">{t.description}</p>
        {t.device && <p className="text-sm text-muted">Device: {t.device}</p>}
        {t.stepsTried.length > 0 && (
          <div className="rounded-2xl bg-canvas p-4">
            <p className="text-sm font-bold">Already tried with the assistant</p>
            <ul className="mt-2 space-y-1.5">
              {t.stepsTried.map((s) => (
                <li key={s.order} className="flex gap-2 text-sm">
                  {s.result === "worked" ? <Check className="mt-0.5 size-4 shrink-0 text-resolved" /> : <X className="mt-0.5 size-4 shrink-0 text-muted" />}
                  <span>
                    <InlineMd text={s.text} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-3 text-sm">
          {t.kbArticleId && (
            <Link to="/articles/$id" params={{ id: t.kbArticleId }} className="font-bold text-brand-700">
              Guide {t.kbArticleId}
            </Link>
          )}
          {t.sessionId && !staff && (
            <Link to="/chat/$sessionId" params={{ sessionId: t.sessionId }} search={{}} className="font-bold text-brand-700">
              Open the conversation
            </Link>
          )}
        </div>
      </Card>

      <section aria-label="Activity" className="space-y-3">
        <h2 className="font-bold">Activity</h2>
        <ol className="space-y-3">
          {timeline.map((item, i) =>
            item.kind === "event" ? (
              <li key={`e${i}`} className="flex items-center gap-2 pl-1 text-sm text-muted">
                <span className="size-2 rounded-full bg-brand-700" />
                {EVENT_LABEL[item.e.type] ?? item.e.type} · {timeAgo(item.at)}
              </li>
            ) : (
              <li
                key={item.c.id}
                className={cn("rounded-2xl border p-4", item.c.visibility === "internal" ? "border-sun bg-sun-50/40 dark:bg-transparent" : "border-line bg-card")}
              >
                <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-muted">
                  {item.c.visibility === "internal" ? <Lock className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                  {item.c.author_name ?? "IT"}
                  {item.c.author_role && item.c.author_role !== "employee" ? " (IT)" : ""} · {timeAgo(item.at)}
                  {item.c.visibility === "internal" ? " · internal note" : ""}
                </p>
                <p className="mt-1.5 whitespace-pre-line text-[15px]">{item.c.body}</p>
              </li>
            ),
          )}
        </ol>
      </section>

      {isOpen(t.status) ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (body.trim()) comment.mutate();
          }}
          className="space-y-3 rounded-card border border-line bg-card p-4"
        >
          <label htmlFor="reply" className="text-sm font-bold">
            {staff ? "Reply or add a note" : "Add a comment for the IT team"}
          </label>
          <textarea
            id="reply"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-24 w-full rounded-2xl border border-control bg-card px-4 py-3 text-[15px] focus:border-brand-700 focus:outline-none"
            placeholder={staff ? "Visible to the employee unless marked internal" : "New details, screenshots described, when it happens…"}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            {staff ? (
              <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="size-4 accent-[#0B6E76]" />
                Internal note (IT only)
              </label>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={!body.trim() || comment.isPending}>
              {internal ? "Add note" : "Send"}
            </Button>
          </div>
          {comment.isError && <p className="text-sm text-critical">Couldn&apos;t send that. Try again.</p>}
        </form>
      ) : (
        !staff && (
          <Card>
            {showReopen ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reopenReason.trim().length >= 3) reopen.mutate();
                }}
                className="space-y-3"
              >
                <label htmlFor="reopen" className="text-sm font-bold">
                  What&apos;s still wrong?
                </label>
                <textarea
                  id="reopen"
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  className="min-h-20 w-full rounded-2xl border border-control bg-card px-4 py-3 text-[15px] focus:border-brand-700 focus:outline-none"
                />
                <div className="flex gap-2">
                  <Button type="submit" disabled={reopenReason.trim().length < 3 || reopen.isPending}>
                    Reopen ticket
                  </Button>
                  <Button variant="ghost" onClick={() => setShowReopen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">Problem came back?</p>
                <Button variant="outline" onClick={() => setShowReopen(true)}>
                  <RotateCcw /> Reopen
                </Button>
              </div>
            )}
          </Card>
        )
      )}
    </div>
  );
}
