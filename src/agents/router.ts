/**
 * Supervisor routing. Rules first (free, instant, predictable); the model only routes what the rules
 * can't place — and it does so inside the supervisor's normal turn by choosing a hand-off tool, so
 * routing never costs an extra model call.
 */
import { detect, VERIFY_TOOL, type NextAction, type SupportState, type UiPart } from "./state";

export type AgentName = "knowledge" | "ticket" | "access" | "password" | "status" | "chat";

export interface RouteDecision {
  agent: AgentName;
  method: "rules" | "llm";
  reason: string;
}

const TICKET_REF = /\b(INC|REQ)-?\d{3,6}\b/i;
const PASSWORD = /\b(forgot|reset|change|expired?|locked)\b.{0,30}\b(password|passcode|account)\b|\b(password|account)\b.{0,20}\b(reset|expired|locked( out)?)\b|\blocked out\b|^\s*(password|passwd|pwd)\s*[?!.]*$/i;
const ACCESS = /\b(need|want|get|request|grant|give me|requesting)\b.{0,25}\b(access|permission|permissions|licen[cs]e)\b|\baccess (to|for)\b|\b(access denied|don'?t have access|no access)\b/i;
const STATUS = /\b(status|update|progress)\b.{0,30}\b(ticket|request|incident)\b|\b(my|any) (open )?(tickets|requests)\b/i;
const SMALL_TALK = /^\s*(hi+|hello|hey|hii+|namaste|good (morning|afternoon|evening)|thanks?( you)?|thank u|ok(ay)?|cool|great|bye)(\s+(there|team|all|everyone))?[\s!.]*$/i;
/** Asking for new or replacement equipment needs IT, not a self-help guide. */
const EQUIPMENT = /\b(need|want|request(ing)?|get|order)\b.{0,25}\b(new|replacement|replace|another|spare)\b.{0,25}\b(laptop|mouse|keyboard|monitor|screen|headset|charger|adapter|dock|phone|webcam)\b|\b(laptop|mouse|keyboard|monitor|headset|charger|dock|webcam)\b.{0,30}\b(broken|cracked|dead|damaged)\b.{0,30}\b(need|replace|replacement|new)\b/i;
const AFFIRMATIVE = /^\s*(yes|yeah|yep|ok(ay)?|sure|please|go ahead|do it|haan|ha|ji|raise it)\b/i;

/**
 * Returns a rules-based route, or null when the supervisor model should decide.
 * Order matters: safety and explicit requests beat everything else.
 */
export function routeByRules(text: string, s: SupportState): RouteDecision | null {
  const t = text.trim();
  if (!t) {
    // A step-card answer (tool result) continues the active guide.
    return s.steps.length ? { agent: "knowledge", method: "rules", reason: "step answer" } : null;
  }
  if (detect.safety(t)) return { agent: "ticket", method: "rules", reason: "safety issue" };
  if (detect.wantsHuman(t)) return { agent: "ticket", method: "rules", reason: "asked for IT / a ticket" };
  if (EQUIPMENT.test(t)) return { agent: "ticket", method: "rules", reason: "equipment request" };
  if (s.escalationReason && !s.ticketNumber && AFFIRMATIVE.test(t)) return { agent: "ticket", method: "rules", reason: "agreed to a ticket" };
  if (TICKET_REF.test(t) || STATUS.test(t)) return { agent: "status", method: "rules", reason: "ticket status" };
  if (PASSWORD.test(t)) return { agent: "password", method: "rules", reason: "password / account" };
  if (ACCESS.test(t)) return { agent: "access", method: "rules", reason: "access request" };
  if (s.awaitingAccessApp && !SMALL_TALK.test(t)) return { agent: "access", method: "rules", reason: "named the app" };
  if (SMALL_TALK.test(t)) return { agent: "chat", method: "rules", reason: "small talk" };
  if (s.steps.length && !s.resolvedByAssistant && !s.escalationReason) {
    return { agent: "knowledge", method: "rules", reason: "active guide" };
  }
  // A new problem description with nothing else going on → troubleshooting is by far the most
  // common intent, so try the guides first. If the Knowledge agent finds nothing, the supervisor
  // model decides what else it could be.
  if (!s.articleId && t.split(/\s+/).length >= 2) return { agent: "knowledge", method: "rules", reason: "new problem" };
  return null;
}

export const AGENT_LABEL: Record<AgentName, string> = {
  knowledge: "Knowledge agent",
  ticket: "Ticket agent",
  access: "Access agent",
  password: "Password reset",
  status: "Ticket status",
  chat: "Assistant",
};

export interface DecideInput {
  route: RouteDecision | null;
  base: NextAction;
  state: SupportState;
  /** The supervisor's last createTicket call was denied by the user. */
  ticketDenied: boolean;
  /** A clarifying question from the Knowledge agent for this turn. */
  clarifyingQuestion: string | null;
}

/** Combines the route with the escalation rules into the one action for this turn. */
export function decide({ route, base, state, ticketDenied, clarifyingQuestion }: DecideInput): NextAction {
  if (ticketDenied && !state.ticketNumber) return { kind: "ticket_cancelled" };
  if (route?.agent === "status") return { kind: "status" };
  if (state.ticketNumber) return base; // ticket_raised
  if (route?.agent === "ticket" && state.ticketDraft) return { kind: "create_ticket", safety: state.escalationReason === "safety" };
  if (route?.agent === "password" || route?.agent === "access") return { kind: "redirect", to: route.agent };
  if (clarifyingQuestion) return { kind: "clarify", question: clarifyingQuestion };
  if (route?.agent === "chat" && (base.kind === "find_article" || base.kind === "resolved")) return { kind: "chat" };
  if (!route && base.kind === "find_article") return { kind: "llm_route" };
  return base;
}

// ─────────────────────────── Phase 6: access & password quick actions ───────────────────────────

/** The Access agent's answer (subset) → this turn's action. */
export function accessAction(
  o: { applicationName: string | null; alreadyHasAccess: boolean; openRequest: { number: string } | null; clarifyingQuestion: string | null } | null,
): NextAction {
  if (!o) return { kind: "redirect", to: "access" };
  if (!o.applicationName) return { kind: "access_info", info: "which_app", question: o.clarifyingQuestion ?? "Which app do you need access to?" };
  if (o.alreadyHasAccess) return { kind: "access_info", info: "has_access", app: o.applicationName };
  if (o.openRequest) return { kind: "access_info", info: "open_request", app: o.applicationName, number: o.openRequest.number };
  return { kind: "access_submit" };
}

/** Starting a password reset → this turn's action. */
export function passwordAction(
  r: { ok: true; maskedEmail: string; accountLocked: boolean } | { ok: false; reason: "rate_limited" | "disabled" | "no_account" } | null,
): NextAction {
  if (!r) return { kind: "password_blocked", reason: "error" };
  return r.ok ? { kind: "password_verify", maskedEmail: r.maskedEmail, accountLocked: r.accountLocked } : { kind: "password_blocked", reason: r.reason };
}

/**
 * Continuations after the user answered one of the Phase 6 cards (approval or code). The server's
 * own state decides — a client can't claim it verified a code.
 */
export function afterToolAction(lastTool: UiPart | undefined, s: SupportState): NextAction | null {
  if (!lastTool) return null;
  const out = (lastTool.output ?? {}) as Record<string, unknown>;
  switch (lastTool.type) {
    case "tool-submitAccessRequest":
      if (lastTool.state === "output-denied") return { kind: "access_cancelled" };
      if (lastTool.state === "output-available" && typeof out.number === "string") {
        return { kind: "access_done", number: out.number, app: String(out.application ?? "the app"), approver: (out.approver as string | null) ?? null, existing: !!out.existing };
      }
      return lastTool.state === "output-available" ? { kind: "redirect", to: "access" } : null;
    case `tool-${VERIFY_TOOL}`:
      if (lastTool.state !== "output-available") return null;
      return s.passwordReset?.stage === "verified" ? { kind: "password_confirm" } : { kind: "password_blocked", reason: "verify_failed" };
    case "tool-resetPassword":
      if (lastTool.state === "output-denied") return { kind: "password_cancelled" };
      if (lastTool.state !== "output-available") return null;
      return out.done === true
        ? { kind: "password_done", maskedEmail: String(out.emailedTo ?? "your email"), unlocked: !!out.unlocked }
        : { kind: "password_blocked", reason: "error" };
    default:
      return null;
  }
}
