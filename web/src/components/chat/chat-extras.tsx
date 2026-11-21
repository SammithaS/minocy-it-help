import { useQuery } from "@tanstack/react-query";
import { BookOpen, CircleAlert, KeyRound, ListChecks, LockKeyhole, MessageCircle, ThumbsDown, ThumbsUp, Ticket, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { chatFeedbackQuery, useSaveFeedback } from "@/lib/chats";
import { cn } from "@/lib/utils";
import type { FollowUpPart, HandoffEvent } from "../../../../src/agents/state";

// ─────────────────────────── hand-off chips ───────────────────────────

const AGENT_STYLE: Record<HandoffEvent["agent"], { icon: LucideIcon; tone: string }> = {
  knowledge: { icon: BookOpen, tone: "bg-sun-50 text-[#0369A1] dark:text-sun" },
  ticket: { icon: Ticket, tone: "bg-brand-50 text-brand-800" },
  access: { icon: LockKeyhole, tone: "bg-[#EEF2FF] text-[#4338CA] dark:bg-[#1E1B4B] dark:text-[#C7D2FE]" },
  password: { icon: KeyRound, tone: "bg-brand-50 text-brand-800" },
  status: { icon: ListChecks, tone: "bg-canvas text-muted" },
  chat: { icon: MessageCircle, tone: "bg-canvas text-muted" },
};

/** "Routed to Access agent · Figma · approver Nikhil Bose", with how it was routed and how long it took. */
export function HandoffChip({ e }: { e: HandoffEvent }) {
  const failed = e.status !== "completed";
  const style = AGENT_STYLE[e.agent] ?? AGENT_STYLE.chat;
  const Icon = failed ? CircleAlert : style.icon;
  const secs = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`;
  return (
    <div
      className={cn("flex w-fit max-w-full items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-xs", failed ? "border-critical/30 bg-critical-bg text-critical" : "border-line bg-card text-muted")}
      title={`Why: ${e.reason}`}
    >
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-full", failed ? "bg-critical/10" : style.tone)}>
        <Icon className="size-3.5" strokeWidth={2.25} />
      </span>
      <span className="min-w-0 truncate">
        <strong className={failed ? "" : "text-ink"}>{e.label}</strong>
        {e.summary ? <span> · {e.summary}</span> : null}
      </span>
      <span className="hidden shrink-0 rounded-full bg-canvas px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase sm:inline" aria-label={e.method === "rules" ? "routed by rule" : "routed by the AI router"}>
        {e.method === "rules" ? "rule" : "AI"} · {secs}
      </span>
    </div>
  );
}

// ─────────────────────────── 24 h follow-up ───────────────────────────

export function FollowUpCard({ data, answered, disabled, onAnswer }: { data: FollowUpPart; answered: boolean; disabled: boolean; onAnswer: (text: string) => void }) {
  if (answered) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label={`Follow-up on ${data.topic}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAnswer("Yes, it's still working — thanks!")}
        className="min-h-11 rounded-full bg-brand-700 px-4 text-sm font-bold text-on-brand disabled:opacity-50"
      >
        Yes, still working
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAnswer("No — it's still not working again")}
        className="min-h-11 rounded-full border border-control px-4 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-50"
      >
        It&apos;s broken again
      </button>
    </div>
  );
}

// ─────────────────────────── 👍 / 👎 ───────────────────────────

/** Shown once the conversation reached an outcome. One rating per chat; changing it replaces it. */
export function FeedbackBar({ sessionId, onRaiseTicket }: { sessionId: string; onRaiseTicket?: () => void }) {
  const { data: saved, isLoading } = useQuery(chatFeedbackQuery(sessionId));
  const save = useSaveFeedback(sessionId);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [comment, setComment] = useState("");
  const current = rating ?? saved?.rating ?? null;
  const asking = current === "down" && !saved?.comment && rating === "down";

  if (isLoading) return null;

  const rate = (r: "up" | "down") => {
    setRating(r);
    save.mutate({ rating: r, comment: r === "down" ? (saved?.comment ?? null) : null });
  };

  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3" aria-label="Feedback">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm font-semibold text-muted">{current ? "Thanks for the feedback!" : "Was this helpful?"}</p>
        {(["up", "down"] as const).map((r) => {
          const Icon = r === "up" ? ThumbsUp : ThumbsDown;
          const on = current === r;
          return (
            <button
              key={r}
              type="button"
              onClick={() => rate(r)}
              aria-pressed={on}
              aria-label={r === "up" ? "Helpful" : "Not helpful"}
              className={cn(
                "grid size-11 place-items-center rounded-full border transition-colors",
                on ? (r === "up" ? "border-brand-700 bg-brand-50 text-brand-800" : "border-critical/40 bg-critical-bg text-critical") : "border-control text-muted hover:bg-canvas hover:text-ink",
              )}
            >
              <Icon className="size-4.5" strokeWidth={2.25} />
            </button>
          );
        })}
      </div>
      {asking && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ rating: "down", comment: comment.trim() || null }, { onSuccess: () => setRating(null) });
          }}
        >
          <label htmlFor={`fb-${sessionId}`} className="text-xs font-bold text-muted">
            What could have gone better? (optional)
          </label>
          <textarea
            id={`fb-${sessionId}`}
            value={comment}
            maxLength={1000}
            onChange={(e) => setComment(e.target.value)}
            className="min-h-16 w-full rounded-xl border border-control bg-card px-3 py-2 text-sm text-ink focus:border-brand-700 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={save.isPending} className="min-h-10 rounded-full bg-brand-700 px-4 text-sm font-bold text-on-brand disabled:opacity-50">
              Send
            </button>
            {onRaiseTicket && (
              <button type="button" onClick={onRaiseTicket} className="min-h-10 rounded-full border border-control px-4 text-sm font-bold text-ink hover:bg-canvas">
                Raise a ticket instead
              </button>
            )}
          </div>
        </form>
      )}
      {save.isError && (
        <p role="alert" className="mt-2 text-xs text-critical">
          Couldn&apos;t save that — try again.
        </p>
      )}
    </div>
  );
}
