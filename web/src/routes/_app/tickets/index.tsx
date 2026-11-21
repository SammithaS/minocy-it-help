import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AppWindow, MessageSquarePlus } from "lucide-react";
import { TicketRow } from "@/components/tickets/ticket-row";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { isOpen, myAccessRequestsQuery, myTicketsQuery, type AccessRequest } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/tickets/")({
  loader: ({ context }) =>
    Promise.all([context.queryClient.ensureQueryData(myTicketsQuery), context.queryClient.ensureQueryData(myAccessRequestsQuery)]),
  component: MyTickets,
});

function MyTickets() {
  const { data: tickets = [] } = useQuery(myTicketsQuery);
  const { data: requests = [] } = useQuery(myAccessRequestsQuery);
  const open = tickets.filter((t) => isOpen(t.status));
  const done = tickets.filter((t) => !isOpen(t.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">My tickets &amp; requests</h1>
          <p className="text-sm text-muted">Problems you&apos;ve raised with the IT team, and app access you&apos;ve asked for.</p>
        </div>
        <Link to="/chat" search={{}} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand-700 px-5 text-sm font-bold text-on-brand">
          <MessageSquarePlus className="size-4" /> Ask IT
        </Link>
      </div>

      {tickets.length === 0 ? (
        <Card>
          <CardTitle>No tickets yet</CardTitle>
          <CardDescription className="mt-1">
            If something isn&apos;t working, ask the assistant — it&apos;ll try to fix it with you first and raise a ticket if needed.
          </CardDescription>
        </Card>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="font-bold">Open ({open.length})</h2>
            {open.length ? open.map((t) => <TicketRow key={t.id} ticket={t} />) : <p className="text-sm text-muted">Nothing open. 🎉</p>}
          </section>
          {done.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-bold">Resolved &amp; closed</h2>
              {done.map((t) => (
                <TicketRow key={t.id} ticket={t} />
              ))}
            </section>
          )}
        </>
      )}

      {requests.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-bold">Access requests ({requests.length})</h2>
          {requests.map((r) => (
            <AccessRequestRow key={r.id} r={r} />
          ))}
        </section>
      )}
    </div>
  );
}

const ACCESS_STATUS: Record<AccessRequest["status"], { label: string; tone: string }> = {
  PENDING: { label: "Waiting for approval", tone: "bg-brand-50 text-brand-800" },
  APPROVED: { label: "Approved · setting up", tone: "bg-brand-50 text-brand-800" },
  PROVISIONING: { label: "Setting up…", tone: "bg-progress-bg text-progress" },
  PENDING_EXTERNAL: { label: "Accept your invite", tone: "bg-progress-bg text-progress" },
  FAILED: { label: "IT is finishing this", tone: "bg-progress-bg text-progress" },
  PROVISIONED: { label: "Access granted", tone: "bg-resolved-bg text-resolved" },
  REJECTED: { label: "Not approved", tone: "bg-critical-bg text-critical" },
  EXPIRED: { label: "Expired", tone: "bg-canvas text-muted" },
};

function AccessRequestRow({ r }: { r: AccessRequest }) {
  const s = ACCESS_STATUS[r.status];
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line bg-card p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        <AppWindow className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-bold">{r.application}</span>
          <span className="text-xs font-semibold text-muted">{r.number}</span>
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", s.tone)}>{s.label}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{r.justification}</p>
        <p className="mt-1 text-xs text-muted">
          {r.approver ? `Approver: ${r.approver} · ` : ""}
          Requested {new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
        </p>
        {r.provisionDetail && r.status !== "FAILED" && <p className="mt-1 text-xs text-ink">{r.provisionDetail}</p>}
        {r.failureTicket && (
          <p className="mt-1 text-xs">
            Tracked in{" "}
            <Link to="/tickets/$number" params={{ number: r.failureTicket }} className="font-bold text-brand-700">
              {r.failureTicket}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
