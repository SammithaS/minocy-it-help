import { createFileRoute, redirect } from "@tanstack/react-router";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/console/settings")({
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: () => (
    <Card>
      <CardTitle>Settings</CardTitle>
      <CardDescription className="mt-1">Routing, SLA and KB settings arrive in Phase 7.</CardDescription>
    </Card>
  ),
});
