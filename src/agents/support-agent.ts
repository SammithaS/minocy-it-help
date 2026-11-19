import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { PRIORITIES } from "../db/schema";
import type { AppEnv } from "../env";
import { chatModel } from "../lib/llm";
import { TICKET_CATEGORIES } from "../org-config";
import { loadGuide } from "./guide";
import { systemPrompt, type UserContext } from "./prompts";
import { AGENT_LABEL, decide, routeByRules, type AgentName, type RouteDecision } from "./router";
import { KnowledgeAgent, type KnowledgeInput, type KnowledgeOutput } from "./specialists/knowledge-agent";
import { TicketAgent, type TicketAgentInput, type TicketDraftOutput } from "./specialists/ticket-agent";
import {
  deriveState,
  detect,
  escalationLabel,
  type HandoffEvent,
  initialSupportState,
  nextAction,
  STEP_TOOL,
  type NextAction,
  type SupportState,
  type TicketDraft,
  type UiMessage,
} from "./state";
import { buildTools, type ToolName } from "./tools";

interface SessionOwner {
  user_id: string;
  name: string;
  department: string | null;
  location: string | null;
  model: string | null;
  os: string | null;
  asset_tag: string | null;
}


const ticketDraftSchema = z.object({
  title: z.string().trim().min(5).max(120),
  summary: z.string().trim().min(10).max(1500),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(PRIORITIES),
});

/** Which tools the model may use for each action — keeps small models on rails. */
const TOOLS_FOR: Record<NextAction["kind"], ToolName[]> = {
  find_article: [],
  llm_route: ["askKnowledgeAgent", "askTicketAgent", STEP_TOOL, "createTicket", "getMyTickets"],
  show_step: [STEP_TOOL, "flagEscalation"],
  await_outcome: ["flagEscalation"],
  resolved: [],
  escalate: ["askTicketAgent", "createTicket"],
  create_ticket: ["createTicket"],
  ticket_cancelled: [],
  ticket_raised: ["getTicketStatus", "addCommentToTicket"],
  clarify: [],
  status: ["getMyTickets", "getTicketStatus", "addCommentToTicket"],
  redirect: ["askTicketAgent", "createTicket"],
  chat: [],
};

/**
 * Supervisor agent — one Durable Object per conversation (instance name = chat session id).
 *
 * Each turn: rebuild state from the transcript → route (rules, else the model picks a hand-off tool)
 * → hand off to a specialist sub-agent if needed (Knowledge, Ticket) → decide the one next action →
 * one model call to talk to the user. Interactive UI (step cards, approval cards) stays here; the
 * specialists are headless. Ownership is enforced in the Worker before requests reach this class.
 */
export class SupportAgent extends AIChatAgent<AppEnv, SupportState> {
  initialState = initialSupportState;
  /** A user double-sending shouldn't produce two answers. */
  messageConcurrency = "latest" as const;
  maxPersistedMessages = 300;

  private ownerCache: SessionOwner | null = null;

  private async owner(): Promise<SessionOwner | null> {
    this.ownerCache ??= await this.env.DB.prepare(
      `SELECT s.user_id, u.name, u.department, u.location, d.model, d.os, d.asset_tag
       FROM chat_sessions s JOIN user u ON u.id = s.user_id
       LEFT JOIN devices d ON d.user_id = s.user_id
       WHERE s.id = ? LIMIT 1`,
    )
      .bind(this.name)
      .first<SessionOwner>();
    return this.ownerCache;
  }

  private deviceLabel(o: SessionOwner | null) {
    if (!o?.model) return null;
    const os = { windows: "Windows", macos: "macOS", linux: "Linux" }[o.os ?? ""] ?? o.os;
    return `${o.model} (${os}, ${o.asset_tag})`;
  }

  // ───────────────────────────── hand-offs ─────────────────────────────

  private async handoff<I, O>(
    agent: AgentName,
    cls: typeof KnowledgeAgent | typeof TicketAgent,
    input: I,
    route: Pick<RouteDecision, "method" | "reason">,
    events: HandoffEvent[],
    summarize: (o: O) => string,
  ): Promise<O | null> {
    const started = Date.now();
    this.setState({ ...this.state, activeAgent: AGENT_LABEL[agent] });
    let status: HandoffEvent["status"] = "error";
    let output: O | null = null;
    let summary = "";
    let error: string | null = null;
    try {
      const r = await this.runAgentTool<I, O>(cls, { input });
      if (r.status === "completed" && r.output) {
        status = "completed";
        output = r.output;
        summary = summarize(r.output);
      } else {
        error = r.error ?? r.status;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ms = Date.now() - started;
    if (error) console.error(`[supervisor] ${agent} hand-off failed: ${error}`);
    events.push({ agent, label: AGENT_LABEL[agent], method: route.method, reason: route.reason, status, summary: summary || "couldn't finish", ms });
    const owner = await this.owner();
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, session_id, user_id, agent, route_method, reason, status, summary, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), this.name, owner?.user_id ?? null, agent, route.method, route.reason, status, summary, error, ms, Date.now())
      .run();
    return output;
  }

  private async runKnowledge(query: string, route: Pick<RouteDecision, "method" | "reason">, events: HandoffEvent[]) {
    const owner = await this.owner();
    const out = await this.handoff<KnowledgeInput, KnowledgeOutput>(
      "knowledge",
      KnowledgeAgent,
      { query, os: (owner?.os as KnowledgeInput["os"]) ?? null, device: this.deviceLabel(owner) },
      route,
      events,
      (o) => (o.articleId ? `${o.articleId} · ${o.title}` : o.clarifyingQuestion ? "needs one detail" : "no matching guide"),
    );
    if (out?.articleId) {
      const g = await loadGuide(this.env, out.articleId, this.state);
      if (g) this.setState(g.state);
    } else {
      this.setState({ ...this.state, lastSearchConfident: out?.clarifyingQuestion ? null : false });
    }
    return out;
  }

  private async runTicketWriter(route: Pick<RouteDecision, "method" | "reason">, events: HandoffEvent[]) {
    const s = this.state;
    const owner = await this.owner();
    const userMessages = (this.messages as unknown as UiMessage[])
      .filter((m) => m.role === "user")
      .map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "))
      .filter((t) => t && !detect.secret(t))
      .slice(-20);
    const stepsTried = s.steps
      .filter((x) => x.status === "worked" || x.status === "failed") // skipped steps weren't tried
      .map((x) => ({ order: x.order, text: x.text, result: x.status as "worked" | "failed" }));
    const out = await this.handoff<TicketAgentInput, TicketDraftOutput>(
      "ticket",
      TicketAgent,
      {
        userMessages,
        stepsTried,
        article: s.articleId ? { id: s.articleId, title: s.articleTitle ?? "", category: s.ticketCategory ?? "software" } : null,
        suggestedPriority: s.escalationReason === "safety" ? "CRITICAL" : s.suggestedPriority,
        escalationReason: s.escalationReason ? escalationLabel[s.escalationReason] : null,
        device: this.deviceLabel(owner),
      },
      route,
      events,
      (o) => `${o.priority} · ${o.title}`,
    );
    if (out) this.setState({ ...this.state, ticketDraft: out satisfies TicketDraft, activeAgent: AGENT_LABEL.ticket });
    return out;
  }

  // ───────────────────────────── the turn ─────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: { abortSignal?: AbortSignal }) {
    const owner = await this.owner();
    const user: UserContext = {
      name: owner?.name ?? "there",
      department: owner?.department ?? null,
      location: owner?.location ?? null,
      device: owner?.model ? { model: owner.model, os: owner.os ?? "windows", assetTag: owner.asset_tag ?? "" } : null,
    };

    // 1. Rebuild guide state from the transcript (button clicks, typed messages).
    const messages = this.messages as unknown as UiMessage[];
    this.setState(deriveState(this.state, messages));
    const last = messages.at(-1);
    const lastTool = [...(last?.parts ?? [])].reverse().find((p) => p.type.startsWith("tool-"));
    const lastUserText =
      last?.role === "user"
        ? last.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")
        : lastTool?.type === `tool-${STEP_TOOL}` && lastTool.state === "output-available"
          ? ((lastTool.output as { note?: string } | undefined)?.note ?? "")
          : "";
    const ticketDenied = lastTool?.type === "tool-createTicket" && lastTool.state === "output-denied";

    // 2. Escalation rules (sticky), then 3. route.
    const base0 = nextAction(this.state, { lastUserText });
    if (base0.kind === "escalate" && this.state.escalationReason !== base0.reason) {
      this.setState({
        ...this.state,
        escalationReason: base0.reason,
        suggestedPriority: base0.reason === "safety" ? "CRITICAL" : this.state.suggestedPriority,
      });
    }
    // Typed messages and step-card answers both go through the routing rules (a card's
    // "Raise a ticket instead" is as explicit as typing it). Other tool continuations don't re-route.
    const fromStepCard = last?.role !== "user" && lastTool?.type === `tool-${STEP_TOOL}`;
    const route = last?.role === "user" || fromStepCard ? routeByRules(lastUserText, this.state) : null;
    const justRaised = lastTool?.type === "tool-createTicket" && lastTool.state === "output-available";

    // 4. Rules-routed hand-offs run before the model call (no tokens spent on routing).
    const events: HandoffEvent[] = [];
    let clarifyingQuestion: string | null = null;
    if (route?.agent === "knowledge" && route.reason === "new problem" && !this.state.articleId) {
      const k = await this.runKnowledge(lastUserText, route, events);
      clarifyingQuestion = k?.clarifyingQuestion ?? null;
    }
    if (route?.agent === "ticket" && !this.state.ticketNumber && !this.state.ticketDraft) {
      if (!this.state.escalationReason) this.setState({ ...this.state, escalationReason: route.reason === "safety issue" ? "safety" : "user_requested" });
      await this.runTicketWriter(route, events);
    }
    if (ticketDenied) this.setState({ ...this.state, ticketDraft: null, escalationReason: null });

    // 5. One action for this turn.
    const action: NextAction =
      justRaised && this.state.ticketNumber
        ? { kind: "ticket_raised", ticketNumber: this.state.ticketNumber, justRaised: true }
        : decide({ route, base: nextAction(this.state, { lastUserText }), state: this.state, ticketDenied, clarifyingQuestion });
    await this.touchSession(lastUserText, action.kind);

    const tools = buildTools({
      env: this.env,
      sessionId: this.name,
      ownerId: owner?.user_id ?? null,
      getState: () => this.state,
      setState: (s) => this.setState(s),
      // Model-chosen hand-offs (only offered in llm_route / escalate / redirect turns).
      askKnowledgeAgent: async (query) => {
        const k = await this.runKnowledge(query, { method: "llm", reason: "model chose guides" }, events);
        return { articleId: k?.articleId ?? null, title: k?.title ?? null, clarifyingQuestion: k?.clarifyingQuestion ?? null, reason: k?.reason ?? "" };
      },
      askTicketAgent: async () => {
        if (!this.state.escalationReason) this.setState({ ...this.state, escalationReason: "user_requested" });
        const d = await this.runTicketWriter({ method: "llm", reason: "model chose a ticket" }, events);
        return d ? { ok: true } : { ok: false, error: "The ticket agent couldn't draft this one. Offer the helpdesk number instead." };
      },
    });

    const modelMessages = await convertToModelMessages(this.messages as UIMessage[]);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        for (const e of events) writer.write({ type: "data-handoff", data: e });
        let emitted = events.length;
        const result = streamText({
          model: chatModel(this.env, { session: this.name, agent: "supervisor" }),
          system: systemPrompt(user, this.state, action, detect.secret(lastUserText)),
          messages: modelMessages,
          tools,
          activeTools: TOOLS_FOR[action.kind],
          stopWhen: isStepCount(5),
          abortSignal: options?.abortSignal,
          temperature: 0.3,
          // Model-chosen hand-offs happen mid-stream; surface their chips as they complete.
          onStepFinish: () => {
            while (events.length > emitted) writer.write({ type: "data-handoff", data: events[emitted++]! });
          },
        });
        writer.merge(result.toUIMessageStream({ sendStart: false }));
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // ───────────────────────────── client RPC ─────────────────────────────

  /** The draft card's "Edit" saves here before the user approves. Validated; only before a ticket exists. */
  @callable()
  async updateTicketDraft(edit: unknown) {
    const s = this.state;
    if (!s.ticketDraft || s.ticketNumber) return { ok: false, error: "There's no open draft to edit." };
    const parsed = ticketDraftSchema.safeParse(edit);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid draft" };
    this.setState({ ...s, ticketDraft: { ...s.ticketDraft, ...parsed.data } });
    return { ok: true };
  }

  /** Spike/diagnostics: proves a sub-agent hand-off round-trips (used by tests and /api/health/subagents). */
  async pingSpecialist(message: string) {
    const { PingAgent } = await import("./specialists/ping-agent");
    return this.runAgentTool<{ message: string }, { echo: string; at: number }>(PingAgent, { input: { message } });
  }

  /** Keeps the D1 summary row (title, outcome, article) in sync for history lists and analytics. */
  private async touchSession(lastUserText: string, kind: string) {
    const s = this.state;
    const outcome = s.ticketNumber ? "escalated" : s.resolvedByAssistant ? "resolved" : kind === "escalate" ? "escalated" : "open";
    const title = lastUserText ? lastUserText.slice(0, 80) : null;
    await this.env.DB.prepare(
      `UPDATE chat_sessions SET title = COALESCE(title, ?), outcome = ?, kb_article_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(title, outcome, s.articleId, Date.now(), this.name)
      .run();
  }
}
