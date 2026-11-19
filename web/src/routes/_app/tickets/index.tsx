import { createFileRoute } from "@tanstack/react-router";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/tickets/")({
  component: () => (
    <Card>
      <CardTitle>My tickets</CardTitle>
      <CardDescription className="mt-1">Tickets you raise will show up here (Phase 4).</CardDescription>
    </Card>
  ),
});
