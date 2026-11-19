import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageSquarePlus } from "lucide-react";
import { TicketRow } from "@/components/tickets/ticket-row";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { isOpen, myTicketsQuery } from "@/lib/tickets";

export const Route = createFileRoute("/_app/tickets/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(myTicketsQuery),
  component: MyTickets,
});

function MyTickets() {
  const { data: tickets = [] } = useQuery(myTicketsQuery);
  const open = tickets.filter((t) => isOpen(t.status));
  const done = tickets.filter((t) => !isOpen(t.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">My tickets</h1>
          <p className="text-sm text-muted">Requests you&apos;ve raised with the IT team.</p>
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
    </div>
  );
}
