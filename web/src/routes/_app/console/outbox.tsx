import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";

interface OutboxEmail {
  id: string;
  kind: string;
  channel: string;
  recipient: string;
  subject: string;
  transport: "log" | "email-service" | "resend";
  status: "sent" | "logged" | "failed" | "skipped";
  error: string | null;
  created_at: number;
  ticket_number: string | null;
}

export const Route = createFileRoute("/_app/console/outbox")({
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: Outbox,
});

const KIND: Record<string, string> = {
  team_new: "New ticket → team",
  critical_admin: "Critical → admin",
  employee_ack: "Confirmation → employee",
  sla_reminder: "SLA reminder → team",
  sla_escalation: "SLA breach → admin",
  resolved_confirm: "Did this fix it? → employee",
  reopened: "Reopened → team",
  digest: "Daily digest → admin",
};

function Outbox() {
  const { data, isPending } = useQuery({
    queryKey: ["console", "outbox"],
    queryFn: () => apiFetch<{ emails: OutboxEmail[] }>("/console/outbox").then((r) => r.emails),
    refetchInterval: 10_000,
  });
  const [open, setOpen] = useState<string | null>(null);
  const selected = data?.find((e) => e.id === open) ?? data?.[0];
  // Fetched and shown via srcDoc in a script-less sandbox (no frame navigation needed).
  const preview = useQuery({
    queryKey: ["console", "outbox", "html", selected?.id],
    queryFn: async () => {
      const res = await fetch(`/api/console/outbox/${selected!.id}`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    },
    enabled: !!selected,
    staleTime: Infinity,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold">Outbox</h1>
        <p className="text-sm text-muted">
          Every email the ticket workflow rendered. With <code>EMAIL_TRANSPORT=log</code> they&apos;re stored here instead of sent — no domain needed.
        </p>
      </div>
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !data?.length ? (
        <Card className="flex items-center gap-3 text-sm text-muted">
          <Mail className="size-5" /> No emails yet. Raise a ticket to see the workflow&apos;s emails here.
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ul className="max-h-[70dvh] space-y-2 overflow-y-auto pr-1">
            {data.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setOpen(e.id)}
                  className={cn("w-full rounded-2xl border bg-card p-3 text-left", selected?.id === e.id ? "border-brand-700" : "border-line hover:border-control")}
                >
                  <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-muted">
                    <span className={cn("rounded-full px-2 py-0.5", e.status === "failed" ? "bg-critical-bg text-critical" : e.status === "sent" ? "bg-resolved-bg text-resolved" : "bg-canvas")}>
                      {e.status}
                    </span>
                    {KIND[e.kind] ?? e.kind} · {timeAgo(e.created_at)}
                  </p>
                  <p className="mt-1 truncate text-sm font-bold">{e.subject}</p>
                  <p className="truncate text-xs text-muted">to {e.recipient}</p>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <Card className="space-y-2 p-0 sm:p-0">
              <div className="border-b border-line p-4 text-sm">
                <p className="font-bold">{selected.subject}</p>
                <p className="text-muted">
                  To {selected.recipient} · via {selected.transport}
                  {selected.ticket_number && (
                    <>
                      {" · "}
                      <Link to="/tickets/$number" params={{ number: selected.ticket_number }} className="font-bold text-brand-700">
                        {selected.ticket_number}
                      </Link>
                    </>
                  )}
                </p>
                {selected.error && <p className="text-critical">{selected.error}</p>}
              </div>
              {preview.data ? (
                <iframe title="Email preview" sandbox="" srcDoc={preview.data} className="h-[60dvh] w-full rounded-b-card bg-white" />
              ) : (
                <p className="p-4 text-sm text-muted">{preview.isError ? "Couldn't load this email." : "Loading preview…"}</p>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
