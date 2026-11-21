/**
 * Support agent state and the deterministic rules that drive it.
 *
 * The model decides *how* to talk; these rules decide *what happens next* (next step, resolve,
 * escalate) so behaviour like "offer a ticket after the steps run out" doesn't depend on the LLM
 * remembering it. State is rebuilt from the persisted transcript on every turn, which keeps it
 * correct across refreshes, reconnects and Durable Object evictions.
 */

export type StepStatus = "pending" | "shown" | "worked" | "failed" | "skipped";
export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface GuideStep {
  order: number;
  section: "quick" | "advanced";
  text: string;
  status: StepStatus;
  note?: string;
}

export type EscalationReason =
  | "user_requested"
  | "not_satisfied"
  | "all_steps_tried"
  | "escalate_condition"
  | "failed_high_priority"
  | "frustration"
  | "no_article"
  | "safety"
  /** Self-service (password reset) couldn't finish: code failed, rate limit, disabled account. */
  | "self_service_failed";

export interface TicketDraft {
  title: string;
  summary: string;
  category: string;
  priority: Priority;
  device: string | null;
  stepsTried: { order: number; text: string; result: "worked" | "failed" }[];
  kbArticleId: string | null;
}

/** What the Access agent found, shown in the access approval card (justification is editable). */
export interface AccessDraft {
  applicationId: string;
  applicationName: string;
  justification: string;
  approverName: string | null;
  approverKind: "manager" | "owner_team" | "admin" | null;
  requiresApproval: boolean;
  ownerTeam: string | null;
}

/** Self-service password reset progress. The code itself never touches state or the transcript. */
export interface PasswordResetState {
  id: string;
  stage: "code_sent" | "verified" | "done";
  maskedEmail: string;
  accountLocked: boolean;
  expiresAt: number;
}

export interface SupportState {
  articleId: string | null;
  articleTitle: string | null;
  articlePriority: Priority | null;
  ticketCategory: string | null;
  steps: GuideStep[];
  /** 1-based number of the step currently shown, or 0 before the first step. */
  currentStep: number;
  failedCount: number;
  frustrationCount: number;
  escalationReason: EscalationReason | null;
  /** Priority to use if a ticket is raised (article priority, bumped for safety / many users). */
  suggestedPriority: Priority | null;
  ticketDraft: TicketDraft | null;
  ticketNumber: string | null;
  resolvedByAssistant: boolean;
  /** Result of the most recent knowledge-base search (null = no search yet). */
  lastSearchConfident: boolean | null;
  /** The specialist the supervisor last handed off to (shown in the chat header). */
  activeAgent: string | null;
  accessDraft: AccessDraft | null;
  accessRequestNumber: string | null;
  /** The Access agent asked which app — the next message is the app name. */
  awaitingAccessApp: boolean;
  passwordReset: PasswordResetState | null;
  /** 24 h "is it still working?" check after the assistant fixed something (Phase 7). */
  followUp: FollowUpState | null;
}

export interface FollowUpState {
  scheduleId: string;
  /** What was fixed, e.g. the guide title. */
  topic: string;
  dueAt: number;
  sent: boolean;
}

/** Persisted as a `data-followup` part on the check-in message; the chat shows two quick answers. */
export interface FollowUpPart {
  topic: string;
  sentAt: number;
}

export const initialSupportState: SupportState = {
  articleId: null,
  articleTitle: null,
  articlePriority: null,
  ticketCategory: null,
  steps: [],
  currentStep: 0,
  failedCount: 0,
  frustrationCount: 0,
  escalationReason: null,
  suggestedPriority: null,
  ticketDraft: null,
  ticketNumber: null,
  resolvedByAssistant: false,
  lastSearchConfident: null,
  activeAgent: null,
  accessDraft: null,
  accessRequestNumber: null,
  awaitingAccessApp: false,
  passwordReset: null,
  followUp: null,
};

// ─────────────────────────── message inspection ───────────────────────────

/** Minimal structural view of AI SDK UI messages, so this module stays dependency-free. */
export interface UiPart {
  type: string;
  text?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
}
export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UiPart[];
}

export const STEP_TOOL = "reportStepOutcome";
/** Client tool: the password-reset code card. Its output is only `{ verified }` — never the code. */
export const VERIFY_TOOL = "verifyResetCode";

export interface StepOutcome {
  /** "skipped" = the user chose to raise a ticket instead of trying this step. */
  outcome: "worked" | "failed" | "skipped";
  note?: string;
}

const userTexts = (messages: UiMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "));

const FRUSTRATION = /\b(useless|not help(ing|ful)|waste of time|ridiculous|annoy(ed|ing)|frustrat\w*|fed up|this is stupid|bakwas|pagal|kuch nahi ho raha)\b|!!!|\?\?\?/i;
const WANTS_HUMAN = /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(human|person|someone|agent|technician|it team|support)\b|\b(real|actual)\s+(human|person)\b|\b(raise|create|open|log)\s+(a\s+)?(ticket|incident|request)\b|\bcall me\b/i;
const NOT_SATISFIED = /\b(not satisfied|didn'?t (help|work)|doesn'?t (help|work)|still (not|isn'?t|doesn'?t) work\w*|still broken|same problem|nothing work(s|ed))\b/i;
const MANY_USERS = /\b(whole|entire)\s+(team|floor|office|department)\b|\b(everyone|everybody|all of us|many (people|users|colleagues)|nobody can|no one can)\b/i;
const SAFETY = /\b(swollen|swelling|bulg\w*|smok(e|ing)|burning smell|smells? (of )?burn\w*|sparks?|fire|melt\w*|spill\w*|liquid|water (on|in|got)|coffee (on|in)|tea (on|in)|shock)\b/i;
/** A 48-digit BitLocker key, or "password/otp/code is …". */
const SECRET = /\b\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}-\d{6}\b|\b(password|passcode|otp|mfa code|pin)\s*(is|:|=)\s*\S+/i;

export const detect = {
  frustration: (t: string) => FRUSTRATION.test(t),
  wantsHuman: (t: string) => WANTS_HUMAN.test(t),
  notSatisfied: (t: string) => NOT_SATISFIED.test(t),
  manyUsers: (t: string) => MANY_USERS.test(t),
  safety: (t: string) => SAFETY.test(t),
  secret: (t: string) => SECRET.test(t),
};

const PRIORITY_ORDER: Priority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const bump = (p: Priority, to: Priority): Priority => (PRIORITY_ORDER.indexOf(to) > PRIORITY_ORDER.indexOf(p) ? to : p);

// ─────────────────────────── state derivation ───────────────────────────

/**
 * Replays step outcomes and user messages onto the guide state.
 * `guide` comes from the last `startGuide` result (the article and its steps).
 */
export function deriveState(prev: SupportState, messages: UiMessage[]): SupportState {
  const s: SupportState = { ...prev, steps: prev.steps.map((x) => ({ ...x, status: "pending" as StepStatus, note: undefined })) };
  s.failedCount = 0;
  s.currentStep = 0;
  s.resolvedByAssistant = false;

  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== `tool-${STEP_TOOL}`) continue;
      const n = Number((p.input as { stepNumber?: unknown } | undefined)?.stepNumber);
      const step = s.steps[n - 1];
      if (!step) continue;
      s.currentStep = Math.max(s.currentStep, n);
      if (p.state === "output-available" && p.output && typeof p.output === "object") {
        const out = p.output as StepOutcome;
        step.status = out.outcome;
        step.note = out.note;
        if (out.outcome === "worked") s.resolvedByAssistant = true;
        else if (out.outcome === "failed") s.failedCount++;
      } else if (step.status === "pending") {
        step.status = "shown";
      }
    }
  }

  // Notes typed into / chosen on a step card count as user text too ("I'd rather raise a ticket").
  const stepNotes = s.steps.map((x) => x.note ?? "").filter(Boolean);
  const texts = [...userTexts(messages), ...stepNotes];
  s.frustrationCount = texts.filter(detect.frustration).length;

  // Priority suggestion: the article's own, bumped for safety or many users affected.
  let priority: Priority | null = s.articlePriority;
  const all = texts.join("\n");
  if (detect.manyUsers(all)) priority = bump(priority ?? "MEDIUM", "HIGH");
  if (detect.safety(all)) priority = "CRITICAL";
  s.suggestedPriority = priority;

  return s;
}

// ─────────────────────────── next action ───────────────────────────

export type NextAction =
  | { kind: "find_article" }
  | { kind: "show_step"; stepNumber: number }
  | { kind: "await_outcome"; stepNumber: number }
  | { kind: "resolved" }
  | { kind: "escalate"; reason: EscalationReason }
  | { kind: "ticket_raised"; ticketNumber: string; justRaised?: boolean }
  // Supervisor-level actions (see router.ts decide()):
  | { kind: "create_ticket"; safety: boolean }
  | { kind: "ticket_cancelled" }
  | { kind: "clarify"; question: string }
  | { kind: "status" }
  | { kind: "redirect"; to: "password" | "access" }
  | { kind: "chat" }
  | { kind: "llm_route" }
  // Phase 6 quick actions (see router.ts accessAction / passwordAction / afterToolAction):
  | { kind: "access_submit" }
  | { kind: "access_info"; info: "has_access" | "open_request" | "which_app"; app?: string; number?: string; question?: string }
  | { kind: "access_done"; number: string; app: string; approver: string | null; existing: boolean }
  | { kind: "access_cancelled" }
  | { kind: "password_verify"; maskedEmail: string; accountLocked: boolean }
  | { kind: "password_confirm" }
  | { kind: "password_done"; maskedEmail: string; unlocked: boolean }
  | { kind: "password_cancelled" }
  | { kind: "password_blocked"; reason: "rate_limited" | "disabled" | "no_account" | "verify_failed" | "error" };

export interface TurnSignals {
  /** The latest user message text ("" when the turn was triggered by a tool result). */
  lastUserText: string;
}

/**
 * Escalate when ANY: user asks for a person / isn't satisfied · all steps tried · 2 failed steps on
 * a HIGH/CRITICAL issue · frustration detected twice · no relevant article · safety issue.
 * ("Escalate when" conditions from the article are judged by the model; see prompts.ts.)
 */
export function nextAction(s: SupportState, sig: TurnSignals): NextAction {
  if (s.ticketNumber) return { kind: "ticket_raised", ticketNumber: s.ticketNumber };
  if (detect.safety(sig.lastUserText)) return { kind: "escalate", reason: "safety" };
  if (detect.wantsHuman(sig.lastUserText)) return { kind: "escalate", reason: "user_requested" };
  if (s.resolvedByAssistant) {
    // A complaint after "that fixed it" re-opens the problem.
    if (detect.notSatisfied(sig.lastUserText)) return { kind: "escalate", reason: "not_satisfied" };
    return { kind: "resolved" };
  }
  if (s.escalationReason) return { kind: "escalate", reason: s.escalationReason };
  if (s.frustrationCount >= 2) return { kind: "escalate", reason: "frustration" };

  if (s.steps.length === 0) {
    if (s.lastSearchConfident === false) return { kind: "escalate", reason: "no_article" };
    return { kind: "find_article" };
  }

  const high = s.articlePriority === "HIGH" || s.articlePriority === "CRITICAL";
  if (high && s.failedCount >= 2) return { kind: "escalate", reason: "failed_high_priority" };

  const current = s.steps[s.currentStep - 1];
  if (current && (current.status === "shown" || current.status === "pending")) {
    return { kind: "await_outcome", stepNumber: s.currentStep };
  }
  if (s.currentStep >= s.steps.length) return { kind: "escalate", reason: "all_steps_tried" };
  return { kind: "show_step", stepNumber: s.currentStep + 1 };
}

export const escalationLabel: Record<EscalationReason, string> = {
  user_requested: "You asked to talk to the IT team",
  not_satisfied: "The fix didn't hold",
  all_steps_tried: "All the self-help steps were tried",
  escalate_condition: "This needs the IT team",
  failed_high_priority: "High-priority issue still not fixed",
  frustration: "This is taking too long",
  no_article: "There's no self-help guide for this",
  safety: "Safety issue — stop using the device",
  self_service_failed: "Self-service couldn't finish this",
};

/** Shown in the chat as "Routed to Knowledge agent · KB-002 …". Persisted as a `data-handoff` message part. */
export interface HandoffEvent {
  agent: "knowledge" | "ticket" | "access" | "password" | "status" | "chat";
  label: string;
  method: "rules" | "llm";
  reason: string;
  status: "completed" | "error";
  summary: string;
  ms: number;
}
