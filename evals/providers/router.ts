/**
 * Routing eval provider: one employee message → which agent the supervisor hands it to.
 *
 * Rules first (routeByRules, as in production). When the rules return null, the supervisor model
 * routes inside its normal turn by picking a hand-off tool — reproduced here with the real system
 * prompt (llm_route action) and the real tool definitions, minus their side effects.
 * Output: { agent, method, tool? }
 */
import { generateText, isStepCount, type Tool } from "ai";
import { systemPrompt } from "../../src/agents/prompts";
import { routeByRules } from "../../src/agents/router";
import { initialSupportState, STEP_TOOL } from "../../src/agents/state";
import { buildTools } from "../../src/agents/tools";
import { chatModel } from "../../src/lib/llm";
import { evalEnv } from "./env";

const TOOL_AGENT: Record<string, string> = {
  askKnowledgeAgent: "knowledge",
  [STEP_TOOL]: "knowledge",
  askTicketAgent: "ticket",
  createTicket: "ticket",
  askAccessAgent: "access",
  submitAccessRequest: "access",
  getMyTickets: "status",
};
const LLM_ROUTE_TOOLS = ["askKnowledgeAgent", "askTicketAgent", "askAccessAgent", STEP_TOOL, "createTicket", "submitAccessRequest", "getMyTickets"];

export default class RouterProvider {
  id() {
    return "supervisor-router";
  }

  async callApi(message: string) {
    const started = Date.now();
    const rule = routeByRules(message, initialSupportState);
    if (rule) return { output: JSON.stringify({ agent: rule.agent, method: "rules", reason: rule.reason }), latencyMs: Date.now() - started };

    const env = await evalEnv();
    const noop = async () => ({ ok: false }) as never;
    const all = buildTools({ env, sessionId: "eval", ownerId: null, getState: () => initialSupportState, setState: () => {}, askKnowledgeAgent: noop, askTicketAgent: noop, askAccessAgent: noop });
    // Same tools the model sees in an llm_route turn, without execute: we only want its first choice.
    const tools = Object.fromEntries(
      Object.entries(all)
        .filter(([name]) => LLM_ROUTE_TOOLS.includes(name))
        .map(([name, t]) => [name, { ...(t as Tool), execute: undefined, needsApproval: undefined }]),
    ) as Record<string, Tool>;
    const user = { name: "Ananya", department: "Finance", location: "Bengaluru", device: { model: "Dell Latitude 7440", os: "windows", assetTag: "MIN-LT-0141" } };
    const r = await generateText({
      model: chatModel(env, { agent: "supervisor", eval: "routing" }),
      system: systemPrompt(user, initialSupportState, { kind: "llm_route" }, false),
      messages: [{ role: "user", content: message }],
      tools,
      stopWhen: isStepCount(1),
      temperature: 0,
    });
    const tool = r.toolCalls[0]?.toolName;
    return { output: JSON.stringify({ agent: tool ? (TOOL_AGENT[tool] ?? tool) : "chat", method: "llm", tool: tool ?? null }), latencyMs: Date.now() - started };
  }
}
