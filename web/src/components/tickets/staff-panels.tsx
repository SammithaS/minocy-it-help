import { useQuery } from "@tanstack/react-query";
import { Bot, Check, ChevronDown, GitBranch, MessagesSquare, SkipForward, X } from "lucide-react";
import { useState } from "react";
import { InlineMd } from "@/components/inline-md";
import { transcriptQuery } from "@/lib/console";
import type { TicketComment } from "@/lib/tickets";
import { cn } from "@/lib/utils";

/** The Triage agent's internal note, pulled to the top for the engineer. */
export function TriageCard({ comments }: { comments: TicketComment[] }) {
  const note = comments.find((c) => c.source === "system" && c.visibility === "internal" && c.body.startsWith("Triage agent:"));
  if (!note) return null;
  return (
    <div className="flex gap-3 rounded-card border border-sun bg-sun-50/60 p-4 dark:bg-transparent">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sun text-[#0F1B2D]">
        <Bot className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-bold tracking-wide text-muted uppercase">Triage agent · internal</p>
        <p className="mt-1 text-[15px] leading-relaxed">{note.body.replace(/^Triage agent:\s*/, "")}</p>
      </div>
    </div>
  );
}

/** What the employee and the assistant already said — collapsed by default. */
export function TranscriptPanel({ number }: { number: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useQuery({ ...transcriptQuery(number), enabled: open });
  return (
    <section className="rounded-card border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-14 w-full items-center gap-2 px-4 text-left font-bold"
      >
        <MessagesSquare className="size-4.5 text-brand-700" />
        Chat transcript
        <span className="text-sm font-normal text-muted">— what the employee and the assistant already covered</span>
        <ChevronDown className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="max-h-[480px] space-y-2.5 overflow-y-auto border-t border-line bg-chat-bg px-4 py-4">
          {isLoading && <p className="text-sm text-muted">Loading…</p>}
          {isError && <p className="text-sm text-critical">Couldn&apos;t load the transcript.</p>}
          {data === null && <p className="text-sm text-muted">This ticket wasn&apos;t raised from a chat.</p>}
          {data?.map((m, i) => {
            if (m.kind === "text") {
              const user = m.role === "user";
              return (
                <div key={i} className={cn("flex", user && "justify-end")}>
                  <p
                    className={cn(
                      "max-w-[85%] whitespace-pre-line rounded-2xl px-3.5 py-2 text-sm",
                      user ? "rounded-br-sm bg-brand-700 text-on-brand" : "rounded-bl-sm border border-line bg-card",
                    )}
                  >
                    {m.text}
                  </p>
                </div>
              );
            }
            const Icon = m.kind === "handoff" ? GitBranch : m.kind === "step" ? (m.outcome === "worked" ? Check : m.outcome === "skipped" ? SkipForward : X) : Bot;
            return (
              <p key={i} className="flex items-start gap-1.5 text-xs text-muted">
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", m.outcome === "worked" && "text-resolved")} />
                <span>
                  <InlineMd text={m.text} />
                  {m.kind === "step" && ` → ${m.outcome}${m.note && m.note !== "Still not working" ? ` (“${m.note}”)` : ""}`}
                </span>
              </p>
            );
          })}
        </div>
      )}
    </section>
  );
}
