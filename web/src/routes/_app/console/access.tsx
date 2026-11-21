import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/console/access")({ component: AccessRequestsPage });

interface Row {
  id: string;
  number: string;
  status: string;
  justification: string;
  external_username: string | null;
  provision_detail: string | null;
  failure_ticket: string | null;
  created_at: number;
  application: string;
  connector: string | null;
  requester: string;
  approver: string | null;
  approver_email: string | null;
}

export const ACCESS_STATUS_TONE: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "Waiting for approval", tone: "bg-new-bg text-new" },
  APPROVED: { label: "Approved", tone: "bg-new-bg text-new" },
  PROVISIONING: { label: "Setting up…", tone: "bg-progress-bg text-progress" },
  PENDING_EXTERNAL: { label: "Invite sent", tone: "bg-progress-bg text-progress" },
  PROVISIONED: { label: "Access granted", tone: "bg-resolved-bg text-resolved" },
  FAILED: { label: "Needs IT", tone: "bg-critical-bg text-critical" },
  REJECTED: { label: "Not approved", tone: "bg-canvas text-muted" },
  EXPIRED: { label: "Expired", tone: "bg-canvas text-muted" },
};

function AccessRequestsPage() {
  const { me } = Route.useRouteContext();
  const qc = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ["console", "access-requests"],
    queryFn: () => apiFetch<{ requests: Row[] }>("/console/access-requests").then((r) => r.requests),
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => apiFetch(`/console/access-requests/${id}/retry`, { method: "POST", body: "{}" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["console", "access-requests"] }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold">
          <KeyRound className="size-6 text-brand-700" /> Access requests
        </h1>
        <p className="text-sm text-muted">Every request and what GitHub, Okta or Atlassian answered. Failed ones also raise a ticket for the app&apos;s team.</p>
      </div>
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !data?.length ? (
        <Card className="text-sm text-muted">No access requests yet.</Card>
      ) : (
        <ul className="space-y-2.5">
          {data.map((r) => {
            const s = ACCESS_STATUS_TONE[r.status] ?? { label: r.status, tone: "bg-canvas text-muted" };
            return (
              <li key={r.id} className="rounded-tile border border-line bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-muted">{r.number}</span>
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", s.tone)}>{s.label}</span>
                  <span className="font-bold">{r.application}</span>
                  <span className="text-sm text-muted">for {r.requester}</span>
                  <span className="ml-auto text-xs text-muted">{timeAgo(r.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {r.justification}
                  {r.external_username ? ` · GitHub: ${r.external_username}` : ""}
                  {r.approver || r.approver_email ? ` · approver ${r.approver ?? r.approver_email}` : ""}
                </p>
                {r.provision_detail && <p className={cn("mt-1.5 text-sm", r.status === "FAILED" ? "text-critical" : "text-ink")}>{r.provision_detail}</p>}
                {(r.failure_ticket || (r.status === "FAILED" && me.user.role === "admin")) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {r.failure_ticket && (
                      <Link to="/tickets/$number" params={{ number: r.failure_ticket }} className="text-sm font-bold text-brand-700">
                        {r.failure_ticket}
                      </Link>
                    )}
                    {r.status === "FAILED" && me.user.role === "admin" && (
                      <Button variant="outline" onClick={() => retry.mutate(r.id)} disabled={retry.isPending}>
                        {retry.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
