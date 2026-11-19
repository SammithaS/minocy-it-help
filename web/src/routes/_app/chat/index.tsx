import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/** /chat → a fresh conversation id (claimed by this user on first connect). */
export const Route = createFileRoute("/_app/chat/")({
  validateSearch: z.object({ q: z.string().max(1000).optional() }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/chat/$sessionId", params: { sessionId: crypto.randomUUID() }, search, replace: true });
  },
});
