import { Link } from "@tanstack/react-router";
import { AppWindow, ArrowRight, CircleCheck, KeyRound, Loader2, Mail, ShieldCheck, UserCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import type { AccessDraft } from "../../../../src/agents/state";

const primary = "inline-flex min-h-11 items-center gap-2 rounded-full bg-sun px-5 text-sm font-bold text-[#0F1B2D] hover:bg-sun-hover disabled:opacity-50";
const quiet = "min-h-11 px-3 text-sm font-bold text-muted hover:text-ink disabled:opacity-50";
const field = "w-full rounded-xl border border-control bg-card px-3 py-2 text-sm text-ink focus:border-brand-700 focus:outline-none";

function Eyebrow({ icon: Icon, children }: { icon: typeof KeyRound; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-800">
      <Icon className="size-4" /> {children}
    </p>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-3 rounded-xl bg-critical-bg px-3 py-2 text-sm text-critical">
      {error}
    </p>
  ) : null;
}

// ─────────────────────────── access ───────────────────────────

/** Approval UI for `submitAccessRequest` (needsApproval). The reason is editable and required. */
export function AccessDraftCard({
  draft,
  busy,
  onApprove,
  onCancel,
}: {
  draft: AccessDraft;
  busy: boolean;
  onApprove: (justification: string, externalUsername: string | null) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [why, setWhy] = useState(draft.justification);
  const [username, setUsername] = useState(draft.externalUsername ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsUsername = !!draft.usernameLabel;
  const isGithub = /github/i.test(draft.usernameLabel ?? "");
  const usernameOk = !needsUsername || (isGithub ? /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(username.trim()) : username.trim().length > 0);
  const ok = why.trim().length >= 10 && usernameOk;

  async function send() {
    setSaving(true);
    setError(null);
    const err = await onApprove(why.trim(), needsUsername ? username.trim() : null);
    setSaving(false);
    if (err) setError(err);
  }

  return (
    <div className="max-w-[94%] rounded-2xl border-2 border-sun bg-card p-4" aria-label="Access request">
      <Eyebrow icon={AppWindow}>Access request · check before sending</Eyebrow>
      <p className="mt-2 text-[15px] font-bold">{draft.applicationName}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
        <UserCheck className="size-4 shrink-0" />
        {draft.requiresApproval
          ? draft.approverName
            ? `${draft.approverName} approves (${draft.approverKind === "manager" ? "your manager" : draft.approverKind === "owner_team" ? "app owner" : "IT admin"})`
            : "Needs approval"
          : "No approval needed — set up straight away"}
      </p>
      {needsUsername && (
        <label className="mt-3 block text-xs font-bold text-muted">
          {draft.usernameLabel}
          <input
            className={cn(field, "mt-1 min-h-11")}
            value={username}
            maxLength={39}
            autoComplete="off"
            spellCheck={false}
            placeholder={isGithub ? "e.g. octocat" : ""}
            onChange={(e) => setUsername(e.target.value)}
          />
          {isGithub && <span className="mt-1 block font-normal">GitHub will email you an invite to accept.</span>}
          {username.trim() && !usernameOk && <span className="mt-1 block font-normal text-critical">That doesn&apos;t look like a GitHub username.</span>}
        </label>
      )}
      <label className="mt-3 block text-xs font-bold text-muted">
        Why do you need it?
        <textarea
          className={cn(field, "mt-1 min-h-20")}
          value={why}
          maxLength={1000}
          placeholder="e.g. I'm joining the website redesign and need to review the mock-ups"
          onChange={(e) => setWhy(e.target.value)}
        />
      </label>
      {!ok && why.length > 0 && <p className="mt-1 text-xs text-muted">A few more words, please (10+ characters).</p>}
      <ErrorLine error={error} />
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={send} disabled={busy || saving || !ok} className={primary}>
          {saving && <Loader2 className="size-4 animate-spin" />} {draft.requiresApproval ? "Send for approval" : "Request access"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy || saving} className={quiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AccessSubmittedCard({ number, app, approver, existing }: { number: string; app: string; approver: string | null; existing: boolean }) {
  return (
    <Link to="/tickets" className="group flex max-w-[94%] items-center gap-3 rounded-2xl bg-brand-50 p-4 text-brand-800">
      <CircleCheck className="size-6 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">
        <span className="block font-bold">
          {number} · {app}
        </span>
        <span className="mt-0.5 block text-sm">
          {existing ? "Already in progress — nothing new sent." : approver ? `Sent to ${approver}. You'll get an email when it's set up.` : "Being set up — you'll get an email."}
        </span>
      </span>
      <ArrowRight className="size-5 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

// ─────────────────────────── password reset ───────────────────────────

/** The code card (client tool). The code goes to the agent's checkResetCode(), never into the chat. */
export function ResetCodeCard({
  maskedEmail,
  busy,
  onCheck,
  onGiveUp,
}: {
  maskedEmail: string;
  busy: boolean;
  onCheck: (code: string) => Promise<string | null>;
  onGiveUp: () => void;
}) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError(null);
    const err = await onCheck(code);
    setChecking(false);
    if (err) {
      setError(err);
      setCode("");
    }
  }

  return (
    <form onSubmit={submit} className="max-w-[94%] rounded-2xl border-2 border-sun bg-card p-4" aria-label="Verification code">
      <Eyebrow icon={Mail}>Check it's you</Eyebrow>
      <p className="mt-2 text-sm text-muted">
        We emailed a 6-digit code to <strong className="text-ink">{maskedEmail}</strong>. It expires in 10 minutes.
      </p>
      <label htmlFor="reset-code" className="sr-only">
        6-digit code
      </label>
      <input
        id="reset-code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="••••••"
        className={cn(field, "mt-3 max-w-44 text-center text-lg font-bold tracking-[0.4em]")}
      />
      <ErrorLine error={error} />
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={busy || checking || code.length !== 6} className={primary}>
          {checking && <Loader2 className="size-4 animate-spin" />} Verify
        </button>
        <button type="button" onClick={onGiveUp} disabled={busy || checking} className={quiet}>
          I didn&apos;t get it — raise a ticket
        </button>
      </div>
    </form>
  );
}

/** Approval UI for `resetPassword` (needsApproval). */
export function ResetConfirmCard({ accountLocked, busy, onApprove, onCancel }: { accountLocked: boolean; busy: boolean; onApprove: () => void; onCancel: () => void }) {
  return (
    <div className="max-w-[94%] rounded-2xl border-2 border-sun bg-card p-4" aria-label="Confirm password reset">
      <Eyebrow icon={KeyRound}>Reset your password?</Eyebrow>
      <ul className="mt-2 space-y-1 text-sm text-muted">
        {accountLocked && <li>• Unlocks your Minocy account</li>}
        <li>• Emails you a one-time link to choose a new password (valid 30 minutes)</li>
        <li>• Your old password stops working once you set the new one</li>
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onApprove} disabled={busy} className={primary}>
          Yes, reset it
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={quiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ResetDoneCard({ emailedTo, unlocked }: { emailedTo: string; unlocked: boolean }) {
  return (
    <div className="flex max-w-[94%] items-center gap-3 rounded-2xl bg-brand-50 p-4 text-brand-800">
      <ShieldCheck className="size-6 shrink-0" strokeWidth={2} />
      <span>
        <span className="block font-bold">{unlocked ? "Account unlocked · link sent" : "Reset link sent"}</span>
        <span className="mt-0.5 block text-sm">Check {emailedTo} for the link to set your new password.</span>
      </span>
    </div>
  );
}

export function StatusLine({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-semibold text-muted">{children}</p>;
}
