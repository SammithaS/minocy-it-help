/**
 * Supervisor routing. Rules first (free, instant, predictable); the model only routes what the rules
 * can't place — and it does so inside the supervisor's normal turn by choosing a hand-off tool, so
 * routing never costs an extra model call.
 */
import { detect, type NextAction, type SupportState } from "./state";

export type AgentName = "knowledge" | "ticket" | "access" | "password" | "status" | "chat";

export interface RouteDecision {
  agent: AgentName;
  method: "rules" | "llm";
  reason: string;
}

const TICKET_REF = /\bINC-?\d{3,6}\b/i;
const PASSWORD = /\b(forgot|reset|change|expired?|locked)\b.{0,30}\b(password|passcode|account)\b|\b(password|account)\b.{0,20}\b(reset|expired|locked( out)?)\b|\blocked out\b/i;
const ACCESS = /\b(need|want|get|request|grant|give me|requesting)\b.{0,25}\b(access|permission|permissions|licen[cs]e)\b|\baccess (to|for)\b|\b(access denied|don'?t have access|no access)\b/i;
const STATUS = /\b(status|update|progress)\b.{0,30}\b(ticket|request|incident)\b|\b(my|any) (open )?tickets\b/i;
const SMALL_TALK = /^\s*(hi+|hello|hey|hii+|namaste|good (morning|afternoon|evening)|thanks?( you)?|thank u|ok(ay)?|cool|great|bye)[\s!.]*$/i;
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
  if (s.escalationReason && !s.ticketNumber && AFFIRMATIVE.test(t)) return { agent: "ticket", method: "rules", reason: "agreed to a ticket" };
  if (TICKET_REF.test(t) || STATUS.test(t)) return { agent: "status", method: "rules", reason: "ticket status" };
  if (PASSWORD.test(t)) return { agent: "password", method: "rules", reason: "password / account" };
  if (ACCESS.test(t)) return { agent: "access", method: "rules", reason: "access request" };
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
