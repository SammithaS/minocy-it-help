import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { ArticleDraft } from "@/lib/console";
import { CATEGORY_LABEL } from "@/lib/tickets";
import { cn } from "@/lib/utils";

const field = "w-full rounded-xl border border-control bg-card px-3 py-2 text-sm text-ink focus:border-brand-700 focus:outline-none";
const OS = [
  ["windows", "Windows"],
  ["macos", "macOS"],
  ["linux", "Linux"],
] as const;
const ACTIONS = [
  ["troubleshoot", "Troubleshoot"],
  ["how_to", "How-to"],
  ["password_reset", "Password reset"],
  ["access_request", "Access request"],
] as const;

export const TEMPLATE = (title: string) => `# ${title}

One line on when to use this guide.

## Symptoms

- What the employee sees

## Quick fixes

1. The simplest thing to try first.

## Advanced steps

1. Something a bit more involved.

## Escalate when

- When to hand over to IT`;

/** Metadata fields + markdown body, with live validation against the same rules as the server. */
export function ArticleForm({ value, onChange }: { value: ArticleDraft; onChange: (v: ArticleDraft) => void }) {
  const [result, setResult] = useState<{ for: ArticleDraft; ok: boolean; text?: string } | null>(null);
  const check: { state: "checking" | "ok" | "error"; text?: string } =
    result?.for !== value ? { state: "checking" } : { state: result.ok ? "ok" : "error", text: result.text };
  const [tagsText, setTagsText] = useState(value.tags.join(", "));
  const set = <K extends keyof ArticleDraft>(k: K, v: ArticleDraft[K]) => onChange({ ...value, [k]: v });

  // Keep the body's "# Title" in step with the title field.
  const setTitle = (title: string) => onChange({ ...value, title, body: value.body.replace(/^#\s+.*$/m, `# ${title}`) });

  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        const r = await apiFetch<{ ok: boolean; error?: string; steps?: number }>("/console/kb/validate", { method: "POST", body: JSON.stringify(value) });
        setResult({ for: value, ok: r.ok, text: r.ok ? `Looks good · ${r.steps} step${r.steps === 1 ? "" : "s"}` : r.error });
      } catch {
        setResult({ for: value, ok: false, text: "Fill in every field (title 5+ characters, 3+ tags, one OS)." });
      }
    }, 500);
    return () => clearTimeout(id);
  }, [value]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-bold text-muted sm:col-span-2">
          Title
          <input className={cn(field, "mt-1 min-h-11")} value={value.title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block text-xs font-bold text-muted">
          Category (shown to employees)
          <input className={cn(field, "mt-1 min-h-11")} value={value.category} maxLength={40} onChange={(e) => set("category", e.target.value)} />
        </label>
        <label className="block text-xs font-bold text-muted">
          Team if it becomes a ticket
          <select className={cn(field, "mt-1 min-h-11")} value={value.ticket_category} onChange={(e) => set("ticket_category", e.target.value)}>
            {Object.entries(CATEGORY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-muted">
          Priority if escalated
          <select className={cn(field, "mt-1 min-h-11")} value={value.priority} onChange={(e) => set("priority", e.target.value as ArticleDraft["priority"])}>
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
              <option key={p} value={p}>
                {p.charAt(0) + p.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-muted">
          Kind
          <select className={cn(field, "mt-1 min-h-11")} value={value.action} onChange={(e) => set("action", e.target.value as ArticleDraft["action"])}>
            {ACTIONS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-bold text-muted sm:col-span-2">
          Search tags (comma-separated — include how people actually say it)
          <input
            className={cn(field, "mt-1 min-h-11")}
            value={tagsText}
            onChange={(e) => {
              setTagsText(e.target.value);
              set(
                "tags",
                e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              );
            }}
          />
        </label>
        <fieldset className="sm:col-span-2">
          <legend className="text-xs font-bold text-muted">Applies to</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {OS.map(([k, l]) => (
              <label key={k} className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="size-4 accent-[#1D4ED8]"
                  checked={value.os.includes(k)}
                  onChange={(e) => set("os", e.target.checked ? [...value.os, k] : value.os.filter((o) => o !== k))}
                />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <label className="block text-xs font-bold text-muted">
        Guide (markdown: title, then Symptoms · Quick fixes · Advanced steps · Escalate when). Placeholders like {"{{vpn_name}}"} are filled in for employees.
        <textarea
          className={cn(field, "mt-1 min-h-[420px] font-mono text-[13px] leading-relaxed")}
          value={value.body}
          spellCheck
          onChange={(e) => set("body", e.target.value)}
        />
      </label>
      <p
        role="status"
        className={cn(
          "flex items-center gap-1.5 text-sm font-semibold",
          check.state === "ok" ? "text-resolved" : check.state === "error" ? "text-critical" : "text-muted",
        )}
      >
        {check.state === "checking" && <Loader2 className="size-4 animate-spin" />}
        {check.state === "ok" && <CircleCheck className="size-4" />}
        {check.state === "error" && <CircleAlert className="size-4" />}
        {check.state === "checking" ? "Checking…" : check.text}
      </p>
    </div>
  );
}

export const isValidDraft = (d: ArticleDraft) => d.title.trim().length >= 5 && d.tags.length >= 3 && d.os.length >= 1 && d.body.trim().length >= 40;
