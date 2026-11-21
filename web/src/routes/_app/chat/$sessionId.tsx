import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, History, MessageSquare, Plus, ThumbsDown, ThumbsUp, Ticket } from "lucide-react";
import { useCallback, useState } from "react";
import { z } from "zod";
import { ChatPanel } from "@/components/chat/chat-panel";
import { myChatsQuery, relativeTime, type ChatSummary } from "@/lib/chats";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/chat/$sessionId")({
  validateSearch: z.object({ q: z.string().max(1000).optional() }),
  params: {
    parse: (p) => ({ sessionId: z.uuid().parse(p.sessionId) }),
    stringify: (p) => p,
  },
  component: ChatPage,
});

/** Full-page chat: the conversation, with your recent chats beside it (a drawer on phones). */
function ChatPage() {
  const { sessionId } = Route.useParams();
  const { q } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [historyOpen, setHistoryOpen] = useState(false);
  // Drop ?q= once sent so a refresh doesn't re-send it.
  const clearQ = useCallback(() => void navigate({ search: {}, replace: true }), [navigate]);

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem-3rem-5rem)] max-w-6xl gap-5 md:h-[calc(100dvh-4rem-4rem)]">
      <aside className="hidden w-72 shrink-0 flex-col lg:flex" aria-label="Recent chats">
        <ChatHistory current={sessionId} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
            <ArrowLeft className="size-4" /> Home
          </Link>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              aria-expanded={historyOpen}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-brand-700 hover:bg-brand-50 lg:hidden"
            >
              <History className="size-4" /> History
            </button>
            <Link to="/chat" search={{}} className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-brand-700 hover:bg-brand-50">
              <Plus className="size-4" /> New chat
            </Link>
          </div>
        </div>
        {historyOpen && (
          <div className="max-h-[45dvh] overflow-y-auto rounded-2xl border border-line bg-card p-2 lg:hidden">
            <ChatHistory current={sessionId} onPick={() => setHistoryOpen(false)} compact />
          </div>
        )}
        <ChatPanel key={sessionId} sessionId={sessionId} initialMessage={q} onInitialMessageSent={clearQ} className="min-h-0 flex-1" />
      </div>
    </div>
  );
}

const OUTCOME: Record<ChatSummary["outcome"], { label: string; icon: typeof CheckCircle2; tone: string }> = {
  resolved: { label: "Fixed", icon: CheckCircle2, tone: "text-resolved" },
  escalated: { label: "Ticket", icon: Ticket, tone: "text-brand-700" },
  open: { label: "Open", icon: MessageSquare, tone: "text-muted" },
  abandoned: { label: "Closed", icon: MessageSquare, tone: "text-muted" },
};

function ChatHistory({ current, onPick, compact }: { current: string; onPick?: () => void; compact?: boolean }) {
  const { data: chats = [], isLoading } = useQuery({ ...myChatsQuery, refetchInterval: 30_000 });
  return (
    <div className={cn("flex min-h-0 flex-col", !compact && "rounded-2xl border border-line bg-card p-2")}>
      {!compact && <h2 className="px-3 pt-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Recent chats</h2>}
      {isLoading ? (
        <p className="px-3 py-2 text-sm text-muted">Loading…</p>
      ) : chats.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted">Your conversations will show up here.</p>
      ) : (
        <ul className="min-h-0 space-y-0.5 overflow-y-auto">
          {chats.map((c) => {
            const o = OUTCOME[c.outcome] ?? OUTCOME.open;
            const active = c.id === current;
            return (
              <li key={c.id}>
                <Link
                  to="/chat/$sessionId"
                  params={{ sessionId: c.id }}
                  search={{}}
                  onClick={onPick}
                  aria-current={active ? "page" : undefined}
                  className={cn("block rounded-xl px-3 py-2.5 hover:bg-canvas", active && "bg-brand-50 hover:bg-brand-50")}
                >
                  <span className={cn("line-clamp-1 text-sm font-semibold", active ? "text-brand-800" : "text-ink")}>{c.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                    <o.icon className={cn("size-3.5", o.tone)} /> {o.label} · {relativeTime(c.updatedAt)}
                    {c.rating === "up" && <ThumbsUp className="ml-auto size-3.5 text-brand-700" aria-label="You rated this helpful" />}
                    {c.rating === "down" && <ThumbsDown className="ml-auto size-3.5 text-critical" aria-label="You rated this not helpful" />}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
