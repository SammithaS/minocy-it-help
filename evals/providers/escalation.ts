/**
 * Escalation eval provider (deterministic, no model): a scripted guide conversation → the
 * supervisor's escalation decision (deriveState + nextAction, exactly as in production).
 *
 * vars: priority (guide priority), steps ("failed,failed,…" outcomes already given, in order),
 *       history (earlier user messages, "|"-separated), message (the latest user message)
 * Output: { kind, reason }
 */
import { deriveState, initialSupportState, nextAction, STEP_TOOL, type Priority, type SupportState, type UiMessage } from "../../src/agents/state";

const GUIDE_STEPS = 6;

export default class EscalationProvider {
  id() {
    return "escalation-rules";
  }

  async callApi(_prompt: string, context: { vars: Record<string, string> }) {
    const v = context.vars;
    const outcomes = (v.steps ?? "").split(",").map((s) => s.trim()).filter(Boolean) as ("worked" | "failed" | "skipped")[];
    const base: SupportState = {
      ...initialSupportState,
      articleId: "KB-TEST",
      articleTitle: "Test guide",
      articlePriority: (v.priority || "MEDIUM") as Priority,
      ticketCategory: "network",
      steps: Array.from({ length: GUIDE_STEPS }, (_, i) => ({ order: i + 1, section: "quick" as const, text: `Step ${i + 1}`, status: "pending" as const })),
    };
    const messages: UiMessage[] = [
      ...(v.history ?? "")
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t, i) => ({ id: `h${i}`, role: "user" as const, parts: [{ type: "text", text: t }] })),
      {
        id: "a",
        role: "assistant",
        parts: outcomes.map((o, i) => ({ type: `tool-${STEP_TOOL}`, toolCallId: `s${i}`, state: "output-available", input: { stepNumber: i + 1 }, output: { outcome: o } })),
      },
      ...(v.message ? [{ id: "last", role: "user" as const, parts: [{ type: "text", text: v.message }] }] : []),
    ];
    const s = deriveState(base, messages);
    const a = nextAction(s, { lastUserText: v.message ?? "" });
    return { output: JSON.stringify({ kind: a.kind, reason: "reason" in a ? a.reason : null }) };
  }
}
