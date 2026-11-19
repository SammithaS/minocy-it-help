import { createFileRoute } from "@tanstack/react-router";
import { PriorityBadge, StatusBadge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/console/")({
  component: Console,
});

function Console() {
  const { me } = Route.useRouteContext();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">IT console</h1>
        <p className="text-sm text-muted">
          Signed in as {me.user.name} ({me.user.role === "admin" ? "IT Admin" : "IT Agent"})
          {me.teams.length > 0 && ` · ${me.teams.map((t) => t.name).join(", ")}`}
        </p>
      </div>
      <Card>
        <CardTitle>Live queue</CardTitle>
        <CardDescription className="mt-1">The live ticket queue arrives in Phase 4.</CardDescription>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusBadge status="NEW" />
          <StatusBadge status="IN_PROGRESS" />
          <StatusBadge status="RESOLVED" />
          <PriorityBadge priority="CRITICAL" />
          <PriorityBadge priority="HIGH" />
        </div>
      </Card>
    </div>
  );
}
