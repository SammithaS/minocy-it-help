/**
 * Ticket-quality eval provider: a chat (employee messages + steps tried) → the Ticket agent's draft
 * (draftTicket, the same function the facet runs). Graded by an LLM judge (judge.ts) on a rubric.
 * vars: messages ("|"-separated), tried ("text→failed;text→failed"), article ("KB-002|Wi-Fi…|network"),
 *       suggested (priority from the rules), reason (escalation reason)
 */
import { draftTicket } from "../../src/agents/specialists/ticket-draft";
import { evalEnv } from "./env";

export default class TicketWriterProvider {
  id() {
    return "ticket-agent";
  }

  async callApi(_prompt: string, context: { vars: Record<string, string> }) {
    const v = context.vars;
    const env = await evalEnv();
    const started = Date.now();
    const [id, title, category] = (v.article ?? "").split("|");
    const draft = await draftTicket(env, {
      userMessages: (v.messages ?? "").split("|").map((m) => m.trim()),
      stepsTried: (v.tried ?? "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s, i) => {
          const [text, result] = s.split("→");
          return { order: i + 1, text: text!.trim(), result: (result?.trim() === "worked" ? "worked" : "failed") as "worked" | "failed" };
        }),
      article: id ? { id, title: title ?? "", category: category ?? "software" } : null,
      suggestedPriority: (v.suggested || null) as never,
      escalationReason: v.reason || null,
      device: "Dell Latitude 7440 (Windows, MIN-LT-0141)",
    });
    return { output: JSON.stringify(draft, null, 2), latencyMs: Date.now() - started };
  }
}
