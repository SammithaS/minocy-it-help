import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, CircleCheck, Loader2, Pencil, Ticket, X } from "lucide-react";
import { useState } from "react";
import { InlineMd } from "@/components/inline-md";
import { PriorityBadge, type Priority } from "@/components/ui/badge";
import { CATEGORY_LABEL } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import type { TicketDraft } from "../../../../src/agents/state";

const CATEGORIES = Object.keys(CATEGORY_LABEL);
const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const field =
  "w-full rounded-xl border border-control bg-card px-3 py-2 text-sm text-ink focus:border-brand-700 focus:outline-none";

/** Approval UI for the supervisor's `createTicket` call (needsApproval). */
export function TicketDraftCard({
  draft,
  busy,
  onApprove,
  onCancel,
}: {
  draft: TicketDraft;
  busy: boolean;
  onApprove: (edited: Pick<TicketDraft, "title" | "summary" | "category" | "priority">) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [summary, setSummary] = useState(draft.summary);
  const [category, setCategory] = useState(draft.category);
  const [priority, setPriority] = useState<Priority>(draft.priority);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setSaving(true);
    setError(null);
    const err = await onApprove({ title, summary, category, priority });
    setSaving(false);
    if (err) setError(err);
  }

  return (
    <div className="max-w-[94%] rounded-2xl border-2 border-sun bg-card p-4" aria-label="Ticket draft">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[#8A5300] dark:text-sun">
        <Ticket className="size-4" /> Ticket draft · check before sending
      </p>

      {editing ? (
        <div className="mt-3 space-y-3">
          <label className="block text-xs font-bold text-muted">
            Title
            <input className={cn(field, "mt-1")} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-xs font-bold text-muted">
            What's happening
            <textarea className={cn(field, "mt-1 min-h-24")} value={summary} maxLength={1500} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-bold text-muted">
              Team
              <select className={cn(field, "mt-1")} value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-bold text-muted">
              Priority
              <select className={cn(field, "mt-1")} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0) + p.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-[15px] font-bold leading-snug">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PriorityBadge priority={priority} />
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-800">{CATEGORY_LABEL[category] ?? category}</span>
            {draft.device && <span className="text-xs text-muted">{draft.device}</span>}
          </div>
        </div>
      )}

      {draft.stepsTried.length > 0 && (
        <div className="mt-3 rounded-xl bg-canvas p-3">
          <p className="text-xs font-bold text-muted">Already tried ({draft.stepsTried.length})</p>
          <ul className="mt-1 space-y-1">
            {draft.stepsTried.map((s) => (
              <li key={s.order} className="flex gap-1.5 text-xs">
                {s.result === "worked" ? <Check className="mt-0.5 size-3.5 shrink-0 text-resolved" /> : <X className="mt-0.5 size-3.5 shrink-0 text-muted" />}
                <span className="line-clamp-2">
                  <InlineMd text={s.text} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={approve}
          disabled={busy || saving || title.trim().length < 5 || summary.trim().length < 10}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-sun px-5 text-sm font-bold text-[#17262A] hover:bg-[#f5a62e] disabled:opacity-50"
        >
          {saving && <Loader2 className="size-4 animate-spin" />} Raise ticket &amp; notify IT
        </button>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          disabled={busy || saving}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-control px-4 text-sm font-bold text-ink hover:bg-canvas disabled:opacity-50"
        >
          <Pencil className="size-4" /> {editing ? "Done" : "Edit"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy || saving}
          className="min-h-11 px-3 text-sm font-bold text-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function TicketRaisedCard({ number, team, priority }: { number: string; team: string; priority: Priority }) {
  return (
    <Link
      to="/tickets/$number"
      params={{ number }}
      className="group flex max-w-[94%] items-center gap-3 rounded-2xl bg-brand-50 p-4 text-brand-800"
    >
      <CircleCheck className="size-6 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">
        <span className="block font-bold">
          {number} raised · {team} notified
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-sm">
          <PriorityBadge priority={priority} /> You&apos;ll get updates here and by email.
        </span>
      </span>
      <ArrowRight className="size-5 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
