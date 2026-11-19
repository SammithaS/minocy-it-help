import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Link } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { AlertTriangle, ArrowUp, BookOpen, Check, GitBranch, Loader2, Sparkles, Ticket, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { InlineMd } from "@/components/inline-md";
import { cn } from "@/lib/utils";
import {
  escalationLabel,
  type HandoffEvent,
  initialSupportState,
  STEP_TOOL,
  type GuideStep,
  type StepOutcome,
  type SupportState,
} from "../../../../src/agents/state";
import type { Priority } from "@/components/ui/badge";
import { MdText } from "./md-text";
import { TicketDraftCard, TicketRaisedCard } from "./ticket-cards";

interface ToolPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
}

const isTool = (p: { type: string }): p is ToolPart => p.type.startsWith("tool-");

/** Typed text while a step card is waiting counts as that step's answer. */
function outcomeFromText(text: string): StepOutcome {
  const worked = /\b(fixed|it works?|working now|works now|resolved|sorted|that did it|all good|ho gaya|chal raha hai)\b/i.test(text) &&
    !/\b(not|n't|nahi|still)\b/i.test(text);
  return { outcome: worked ? "worked" : "failed", note: text.slice(0, 300) };
}

export function ChatPanel({
  sessionId,
  initialMessage,
  onInitialMessageSent,
  className,
}: {
  sessionId: string;
  initialMessage?: string;
  onInitialMessageSent?: () => void;
  className?: string;
}) {
  const [state, setState] = useState<SupportState>(initialSupportState);
  const [dismissedEscalation, setDismissedEscalation] = useState(false);
  const agent = useAgent<SupportState>({
    agent: "support-agent",
    name: sessionId,
    onStateUpdate: (s) => setState(s),
  });
  const { messages, sendMessage, addToolOutput, addToolApprovalResponse, status, error } = useAgentChat({ agent });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  const busy = status === "submitted" || status === "streaming";

  // Send the hero/ask-box message once, but only into a fresh conversation.
  useEffect(() => {
    if (!initialMessage || sentInitial.current || !agent.identified) return;
    sentInitial.current = true;
    if (messages.length === 0) void sendMessage({ role: "user", parts: [{ type: "text", text: initialMessage }] });
    onInitialMessageSent?.();
  }, [initialMessage, agent.identified, messages.length, sendMessage, onInitialMessageSent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  const pendingStep = useMemo(() => {
    for (const m of messages) for (const p of m.parts) if (isTool(p) && p.type === `tool-${STEP_TOOL}` && p.state === "input-available") return p;
    return null;
  }, [messages]);

  const pendingApproval = useMemo(() => {
    for (const m of messages)
      for (const p of m.parts) if (isTool(p) && p.type === "tool-createTicket" && p.state === "approval-requested") return p as ToolPart & { approval?: { id: string } };
    return null;
  }, [messages]);

  async function approveTicket(edited: Parameters<React.ComponentProps<typeof TicketDraftCard>["onApprove"]>[0]): Promise<string | null> {
    if (!pendingApproval?.approval) return "This draft has expired. Ask me to raise the ticket again.";
    const d = state.ticketDraft;
    const changed = !d || d.title !== edited.title || d.summary !== edited.summary || d.category !== edited.category || d.priority !== edited.priority;
    if (changed) {
      const r = (await agent.call("updateTicketDraft", [edited])) as { ok: boolean; error?: string };
      if (!r.ok) return r.error ?? "Couldn't save your changes.";
    }
    void addToolApprovalResponse({ id: pendingApproval.approval.id, approved: true });
    return null;
  }

  function cancelTicket() {
    if (pendingApproval?.approval) void addToolApprovalResponse({ id: pendingApproval.approval.id, approved: false });
  }

  function answerStep(part: ToolPart, outcome: StepOutcome) {
    void addToolOutput({ tool: STEP_TOOL, toolCallId: part.toolCallId, output: outcome } as Parameters<typeof addToolOutput>[0]);
  }

  function submit(e?: FormEvent, override?: string) {
    e?.preventDefault();
    const text = (override ?? input).trim();
    if (!text) return;
    setInput("");
    if (pendingStep) answerStep(pendingStep, outcomeFromText(text));
    else void sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  const showEscalation =
    !!state.escalationReason &&
    !state.ticketNumber &&
    !state.ticketDraft &&
    !pendingApproval &&
    !busy &&
    !dismissedEscalation &&
    !pendingStep &&
    messages.length > 0;

  return (
    <section
      aria-label="Ask IT chat"
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-[24px] bg-card shadow-chat", className)}
    >
      <header className="flex items-center gap-3 bg-ink-surface px-5 py-4 text-white">
        <span className="grid size-10 place-items-center rounded-full bg-sun text-[#0F1B2D]">
          <Sparkles className="size-5" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold leading-tight">Ask IT</h2>
          <p className="truncate text-xs text-white/70">
            {busy && state.activeAgent
              ? `${state.activeAgent} is working…`
              : state.ticketNumber
                ? `Ticket ${state.ticketNumber}`
                : state.articleTitle
                  ? `Guide: ${state.articleTitle}`
                  : "Fixes from the IT guides · a person if you need one"}
          </p>
        </div>
        <span className={cn("ml-auto size-2.5 rounded-full", agent.identified ? "bg-[#4ADE80]" : "bg-white/30")} title={agent.identified ? "Connected" : "Connecting"} />
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-chat-bg px-4 py-5" aria-live="polite">
        {messages.length === 0 && !busy && (
          <div className="rounded-2xl border border-line bg-card p-4 text-[15px]">
            Hi! Tell me what&apos;s not working and I&apos;ll walk you through the fix, one step at a time.
          </div>
        )}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            state={state}
            onAnswer={answerStep}
            onApproveTicket={approveTicket}
            onCancelTicket={cancelTicket}
            disabled={busy}
          />
        ))}
        {busy && messages.at(-1)?.role !== "assistant" && <Typing />}
        {status === "error" && (
          <p role="alert" className="rounded-2xl bg-critical-bg px-4 py-3 text-sm text-critical">
            Something went wrong{error?.message ? `: ${error.message}` : ""}. Try sending your message again.
          </p>
        )}
        {showEscalation && (
          <div className="rounded-2xl border border-line bg-card p-4">
            <p className="flex items-center gap-2 text-sm font-bold">
              {state.escalationReason === "safety" ? (
                <AlertTriangle className="size-4 text-critical" />
              ) : (
                <Ticket className="size-4 text-brand-700" />
              )}
              {escalationLabel[state.escalationReason!]}
            </p>
            <p className="mt-1 text-sm text-muted">
              I can raise a ticket with everything we&apos;ve tried, so you won&apos;t have to explain again.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => submit(undefined, "Yes, please raise a ticket")}
                className="min-h-11 rounded-full bg-sun px-5 text-sm font-bold text-[#0F1B2D] hover:bg-sun-hover"
              >
                Yes, raise a ticket
              </button>
              <button
                type="button"
                onClick={() => setDismissedEscalation(true)}
                className="min-h-11 rounded-full border border-control px-5 text-sm font-bold text-ink hover:bg-canvas"
              >
                Not now
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-line bg-card p-3">
        <label htmlFor={`chat-${sessionId}`} className="sr-only">
          Message
        </label>
        <input
          id={`chat-${sessionId}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={pendingStep ? "Or tell me what happened…" : "Describe the problem…"}
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 rounded-full border border-control bg-card px-4 text-[15px] text-ink placeholder:text-muted focus:border-brand-700 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || busy}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-700 text-on-brand disabled:opacity-40"
        >
          <ArrowUp className="size-5" strokeWidth={2.25} />
        </button>
      </form>
    </section>
  );
}

function Typing() {
  return (
    <div className="flex w-fit items-center gap-1 rounded-[18px_18px_18px_4px] border border-line bg-card px-4 py-3" aria-label="Assistant is typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-2 animate-bounce rounded-full bg-muted/60" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

function HandoffChip({ e }: { e: HandoffEvent }) {
  return (
    <p className={cn("flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold", e.status === "completed" ? "bg-canvas text-muted" : "bg-critical-bg text-critical")}>
      <GitBranch className="size-3.5" />
      <span>
        Routed to <strong className="text-ink">{e.label}</strong>
        {e.summary ? ` · ${e.summary}` : ""}
      </span>
      <span className="sr-only">({e.method === "rules" ? "by rule" : "by the router model"}, {e.ms} ms)</span>
    </p>
  );
}

function Message({
  message,
  state,
  onAnswer,
  onApproveTicket,
  onCancelTicket,
  disabled,
}: {
  message: UIMessage;
  state: SupportState;
  onAnswer: (part: ToolPart, outcome: StepOutcome) => void;
  onApproveTicket: React.ComponentProps<typeof TicketDraftCard>["onApprove"];
  onCancelTicket: () => void;
  disabled: boolean;
}) {
  const steps = state.steps;
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[18px_18px_4px_18px] bg-brand-700 px-4 py-2.5 text-[15px] text-on-brand">{text}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.parts.map((p, i) => {
        if (p.type === "text") {
          if (!p.text.trim()) return null;
          return (
            <div key={i} className="max-w-[90%] rounded-[18px_18px_18px_4px] border border-line bg-card px-4 py-2.5 text-[15px] leading-relaxed">
              <MdText text={p.text} />
            </div>
          );
        }
        if (p.type === "data-handoff") return <HandoffChip key={i} e={(p as unknown as { data: HandoffEvent }).data} />;
        if (!isTool(p)) return null;
        if (p.type === "tool-createTicket") {
          if (p.state === "approval-requested" && state.ticketDraft && !state.ticketNumber) {
            return <TicketDraftCard key={p.toolCallId} draft={state.ticketDraft} busy={disabled} onApprove={onApproveTicket} onCancel={onCancelTicket} />;
          }
          if (p.state === "output-available" && p.output?.number) {
            return (
              <TicketRaisedCard
                key={p.toolCallId}
                number={String(p.output.number)}
                team={String(p.output.team ?? "IT")}
                priority={(p.output.priority as Priority) ?? "MEDIUM"}
              />
            );
          }
          if (p.state === "output-denied") {
            return (
              <p key={p.toolCallId} className="text-xs font-semibold text-muted">
                Ticket cancelled
              </p>
            );
          }
          return null;
        }
        if (p.type === "tool-searchKnowledgeBase") {
          return (
            <p key={p.toolCallId} className="flex items-center gap-1.5 text-xs font-semibold text-muted">
              {p.state === "output-available" ? <BookOpen className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
              {p.state === "output-available" ? "Checked the IT guides" : "Checking the IT guides…"}
            </p>
          );
        }
        if (p.type === "tool-startGuide" && p.state === "output-available" && p.output?.articleId) {
          return (
            <Link
              key={p.toolCallId}
              to="/articles/$id"
              params={{ id: String(p.output.articleId) }}
              target="_blank"
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-800"
            >
              <BookOpen className="size-3.5" /> {String(p.output.articleId)} · {String(p.output.title)}
            </Link>
          );
        }
        if (p.type === `tool-${STEP_TOOL}`) {
          return <StepCard key={p.toolCallId} part={p} steps={steps} onAnswer={onAnswer} disabled={disabled} />;
        }
        return null;
      })}
    </div>
  );
}

function StepCard({
  part,
  steps,
  onAnswer,
  disabled,
}: {
  part: ToolPart;
  steps: GuideStep[];
  onAnswer: (part: ToolPart, outcome: StepOutcome) => void;
  disabled: boolean;
}) {
  const n = Number(part.input?.stepNumber);
  const step = steps[n - 1];
  const answered = part.state === "output-available" ? (part.output as unknown as StepOutcome) : null;
  if (!step) return null;

  return (
    <div className={cn("max-w-[92%] rounded-2xl border bg-card p-4", answered ? "border-line" : "border-brand-700/40")}>
      <p className="text-xs font-bold uppercase tracking-wide text-brand-700">
        Step {n} of {steps.length}
      </p>
      <p className="mt-1.5 text-[15px] leading-relaxed">
        <InlineMd text={step.text} />
      </p>
      {answered ? (
        <p className={cn("mt-3 inline-flex items-center gap-1.5 text-sm font-bold", answered.outcome === "worked" ? "text-resolved" : "text-muted")}>
          {answered.outcome === "worked" ? <Check className="size-4" /> : <X className="size-4" />}
          {answered.outcome === "worked" ? "That fixed it" : answered.note && answered.note !== "Still not working" ? `“${answered.note}”` : "Still not working"}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(part, { outcome: "worked" })}
            className="min-h-11 rounded-full bg-brand-700 px-4 text-sm font-bold text-on-brand disabled:opacity-50"
          >
            That fixed it
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(part, { outcome: "failed", note: "Still not working" })}
            className="min-h-11 rounded-full border border-control px-4 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-50"
          >
            Still not working
          </button>
          {n > 1 && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(part, { outcome: "skipped", note: "I'd rather raise a ticket with IT" })}
              className="min-h-11 px-2 text-sm font-bold text-brand-700 underline-offset-2 hover:underline disabled:opacity-50"
            >
              Raise a ticket instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}
