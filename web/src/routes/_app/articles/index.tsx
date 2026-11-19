import { createFileRoute } from "@tanstack/react-router";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/articles/")({
  component: () => (
    <Card>
      <CardTitle>Guides</CardTitle>
      <CardDescription className="mt-1">The IT knowledge base arrives in Phase 2.</CardDescription>
    </Card>
  ),
});
