import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";
import { ChatPanel } from "@/components/chat/chat-panel";

export const Route = createFileRoute("/_app/chat/$sessionId")({
  validateSearch: z.object({ q: z.string().max(1000).optional() }),
  params: {
    parse: (p) => ({ sessionId: z.uuid().parse(p.sessionId) }),
    stringify: (p) => p,
  },
  component: ChatPage,
});

function ChatPage() {
  const { sessionId } = Route.useParams();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // Drop ?q= once sent so a refresh doesn't re-send it.
  const clearQ = useCallback(() => void navigate({ search: {}, replace: true }), [navigate]);

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem-3rem-5rem)] max-w-3xl flex-col gap-3 md:h-[calc(100dvh-4rem-4rem)]">
      <div className="flex items-center justify-between">
        <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
          <ArrowLeft className="size-4" /> Home
        </Link>
        <Link to="/chat" search={{}} className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-brand-700 hover:bg-brand-50">
          <Plus className="size-4" /> New chat
        </Link>
      </div>
      <ChatPanel key={sessionId} sessionId={sessionId} initialMessage={q} onInitialMessageSent={clearQ} className="flex-1" />
    </div>
  );
}
