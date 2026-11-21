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
import { justificationSchema } from "../lib/access";
import { chatFollowUp } from "../email/chat-messages";
import { sendEmail } from "../email/send";
import { chatModel } from "../lib/llm";
import { startPasswordReset, verifyResetCode } from "../lib/password-reset";
import { TICKET_CATEGORIES } from "../org-config";
import { loadGuide } from "./guide";
import { systemPrompt, type UserContext } from "./prompts";
import { accessAction, afterToolAction, AGENT_LABEL, decide, passwordAction, routeByRules, type AgentName, type RouteDecision } from "./router";
import { AccessAgent, type AccessAgentInput, type AccessAgentOutput } from "./specialists/access-agent";
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
  VERIFY_TOOL,
  type NextAction,
  type SupportState,
  type TicketDraft,
  type UiMessage,
} from "./state";
import { buildTools, type ToolName } from "./tools";

interface SessionOwner {
  user_id: string;
  name: string;
  email: string;
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
  llm_route: ["askKnowledgeAgent", "askTicketAgent", "askAccessAgent", STEP_TOOL, "createTicket", "submitAccessRequest", "getMyTickets"],
  show_step: [STEP_TOOL, "flagEscalation"],
  await_outcome: ["flagEscalation"],
  resolved: [],
  escalate: ["askTicketAgent", "createTicket"],
  create_ticket: ["createTicket"],
  ticket_cancelled: [],
  ticket_raised: ["getTicketStatus", "addCommentToTicket"],
  clarify: [],
  status: ["getMyTickets", "getTicketStatus", "addCommentToTicket", "getMyAccessRequests"],
  redirect: ["askTicketAgent", "createTicket"],
  chat: [],
  access_submit: ["submitAccessRequest"],
  access_info: [],
  access_done: ["getMyAccessRequests"],
  access_cancelled: [],
  password_verify: [VERIFY_TOOL],
  password_confirm: ["resetPassword"],
  password_done: [],
  password_cancelled: [],
  password_blocked: ["askTicketAgent", "createTicket"],
};

/**
 * Card actions where the next step must be a specific tool call. The supervisor writes the one-line
 * lead-in itself and forces the call, so the card always appears (a directive alone sometimes got a
 * "we've emailed you a code" sentence with no card).
 */
function forcedCard(action: NextAction, s: SupportState): { tool: ToolName; lead: string } | null {
  switch (action.kind) {
    case "access_submit": {
      const d = s.accessDraft;
      if (!d) return null;
      const who = d.requiresApproval && d.approverName ? ` — ${d.approverName} will be asked to approve it` : "";
      return { tool: "submitAccessRequest", lead: `Here's your request for **${d.applicationName}**${who}. ${d.justification ? "Check it and send it when you're happy." : "Add a line on why you need it, then send it."}` };
    }
    case "password_verify":
      return {
        tool: VERIFY_TOOL,
        lead: `${action.accountLocked ? "Your account is locked — I can unlock it and reset your password. " : "I can reset your password for you. "}First, a quick check that it's you: I've emailed a 6-digit code to ${action.maskedEmail}. Type it into the card below (never into the chat).`,
      };
    case "password_confirm":
      return { tool: "resetPassword", lead: "Thanks, that's confirmed. One last check before I reset it:" };
    default:
      return null;
  }
}

/**
 * Confirmations that carry facts (numbers, who approves, what was emailed) are written here, not by
 * the model — no hallucinated "temporary password", and no model call spent on them.
 */
function fixedReply(action: NextAction): string | null {
  switch (action.kind) {
    case "access_done":
      return action.existing
        ? `You already have an open request for ${action.app} (${action.number}), so I didn't send another. You'll get an email as soon as it's done.`
        : `Done — request **${action.number}** for ${action.app} is ${action.approver ? `with ${action.approver} for approval` : "being set up"}. Once it's approved, access is set up automatically and you'll get an email. Nothing else to do for now.`;
    case "access_cancelled":
      return "No problem — I haven't sent anything. Ask me any time if you need access later.";
    case "password_done":
      return `All set${action.unlocked ? " — your account is unlocked" : ""}. I've emailed a one-time link to ${action.maskedEmail} to choose your new password; it works once and expires in 30 minutes. After that, sign in on your laptop and in Minocy apps with the new password.`;
    case "password_cancelled":
      return "Okay, I've cancelled the reset — nothing changed on your account.";
    default:
      return null;
  }
}

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
      `SELECT s.user_id, u.name, u.email, u.department, u.location, d.model, d.os, d.asset_tag
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
    cls: typeof KnowledgeAgent | typeof TicketAgent | typeof AccessAgent,
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
    if (error) console.error(`[supervisor] ${agent} hand-off failed: ${error}`);
    await this.logRun(agent, route, events, { status, summary, error, ms: Date.now() - started });
    return output;
  }

  /** A chip in the chat + a row in agent_runs (analytics, routing eval). */
  private async logRun(
    agent: AgentName,
    route: Pick<RouteDecision, "method" | "reason">,
    events: HandoffEvent[],
    r: { status: HandoffEvent["status"]; summary: string; error: string | null; ms: number },
  ) {
    events.push({ agent, label: AGENT_LABEL[agent], method: route.method, reason: route.reason, status: r.status, summary: r.summary || "couldn't finish", ms: r.ms });
    const owner = await this.owner();
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, session_id, user_id, agent, route_method, reason, status, summary, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), this.name, owner?.user_id ?? null, agent, route.method, route.reason, r.status, r.summary, r.error, r.ms, Date.now())
      .run();
  }

  /** The employee's recent messages (no secrets), oldest first. */
  private recentUserTexts(limit = 20) {
    return (this.messages as unknown as UiMessage[])
      .filter((m) => m.role === "user")
      .map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" "))
      .filter((t) => t && !detect.secret(t))
      .slice(-limit);
  }

  private async runAccess(route: Pick<RouteDecision, "method" | "reason">, events: HandoffEvent[], extra?: string) {
    const owner = await this.owner();
    if (!owner) return null;
    const userMessages = this.recentUserTexts(10);
    if (extra && userMessages.at(-1) !== extra) userMessages.push(extra);
    if (!userMessages.length) return null;
    const out = await this.handoff<AccessAgentInput, AccessAgentOutput>("access", AccessAgent, { requesterId: owner.user_id, userMessages }, route, events, (o) =>
      !o.applicationName ? "needs the app name" : o.alreadyHasAccess ? `${o.applicationName} · already has it` : o.openRequest ? `${o.applicationName} · ${o.openRequest.number} open` : `${o.applicationName} · approver ${o.approver?.name ?? "not needed"}`,
    );
    this.setState({
      ...this.state,
      awaitingAccessApp: !!out && !out.applicationName,
      accessDraft:
        out?.applicationId && out.applicationName && !out.alreadyHasAccess && !out.openRequest
          ? {
              applicationId: out.applicationId,
              applicationName: out.applicationName,
              justification: out.justification,
              approverName: out.approver?.name ?? null,
              approverKind: out.approver?.kind ?? null,
              requiresApproval: out.requiresApproval,
              ownerTeam: out.ownerTeam,
            }
          : null,
    });
    return out;
  }

  /** Password reset is a deterministic tool flow, not a model: start it before the model call. */
  private async runPasswordStart(route: Pick<RouteDecision, "method" | "reason">, events: HandoffEvent[]) {
    const owner = await this.owner();
    if (!owner) return null;
    const started = Date.now();
    try {
      const r = await startPasswordReset(this.env, { userId: owner.user_id, sessionId: this.name });
      if (r.ok) {
        this.setState({
          ...this.state,
          activeAgent: AGENT_LABEL.password,
          passwordReset: { id: r.resetId, stage: "code_sent", maskedEmail: r.maskedEmail, accountLocked: r.accountLocked, expiresAt: r.expiresAt },
        });
      }
      await this.logRun("password", route, events, {
        status: "completed",
        summary: r.ok ? `code sent to ${r.maskedEmail}` : r.reason.replace("_", " "),
        error: null,
        ms: Date.now() - started,
      });
      return r;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[supervisor] password reset failed:", error);
      await this.logRun("password", route, events, { status: "error", summary: "", error, ms: Date.now() - started });
      return null;
    }
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
    const userMessages = this.recentUserTexts(20);
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

    // Phase 6 quick actions: card answers first, then rules-routed access / password requests.
    let quick: NextAction | null = afterToolAction(lastTool, this.state);
    if (!quick && route?.agent === "access") quick = accessAction(await this.runAccess(route, events));
    if (!quick && route?.agent === "password") quick = passwordAction(await this.runPasswordStart(route, events));
    if (quick?.kind === "password_blocked" || (quick?.kind === "redirect" && quick.to === "password")) {
      this.setState({ ...this.state, escalationReason: "self_service_failed", passwordReset: null });
    }
    if (quick?.kind === "access_cancelled") this.setState({ ...this.state, accessDraft: null });

    // 5. One action for this turn.
    const action: NextAction =
      justRaised && this.state.ticketNumber
        ? { kind: "ticket_raised", ticketNumber: this.state.ticketNumber, justRaised: true }
        : (quick ?? decide({ route, base: nextAction(this.state, { lastUserText }), state: this.state, ticketDenied, clarifyingQuestion }));
    await this.touchSession(lastUserText, action.kind);
    await this.syncFollowUp(action);

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
      askAccessAgent: async (request) => {
        const o = await this.runAccess({ method: "llm", reason: "model chose access" }, events, request);
        const a = accessAction(o);
        if (a.kind === "access_submit") return { guidance: "Now call submitAccessRequest so the user can review and send the request." };
        if (a.kind === "access_info" && a.info === "has_access") return { guidance: `They already have ${a.app}. Tell them; don't submit anything.` };
        if (a.kind === "access_info" && a.info === "open_request") return { guidance: `Request ${a.number} for ${a.app} is already open. Tell them; don't submit another.` };
        if (a.kind === "access_info") return { guidance: `Ask: ${a.question}` };
        return { guidance: "The Access agent couldn't help. Offer a ticket with the Identity & Access team." };
      },
    });

    // An approved access request / password reset: run the tool here and confirm with fixed text, instead
    // of letting the SDK run it inside another model call (which then paraphrased the result).
    const approvedNow =
      last?.role === "assistant" &&
      lastTool?.state === "approval-responded" &&
      (lastTool.type === "tool-submitAccessRequest" || lastTool.type === "tool-resetPassword")
        ? lastTool
        : null;
    if (approvedNow?.toolCallId) {
      const name = approvedNow.type.slice("tool-".length) as "submitAccessRequest" | "resetPassword";
      const toolCallId = approvedNow.toolCallId;
      const output = (await tools[name].execute!({}, { toolCallId, messages: [], context: {} as never })) as Record<string, unknown>;
      const after = afterToolAction({ ...approvedNow, state: "output-available", output }, this.state);
      if (after?.kind === "password_blocked") this.setState({ ...this.state, escalationReason: "self_service_failed", passwordReset: null });
      const reply =
        (after && fixedReply(after)) ??
        (typeof output.error === "string" ? `Sorry — that didn't go through: ${output.error}` : "Sorry — that didn't go through. Want me to raise a ticket with the IT team instead?");
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "tool-output-available", toolCallId, output });
          writer.write({ type: "text-start", id: "reply" });
          writer.write({ type: "text-delta", id: "reply", delta: reply });
          writer.write({ type: "text-end", id: "reply" });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }

    const modelMessages = await convertToModelMessages(this.messages as UIMessage[]);
    const forced = forcedCard(action, this.state);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        for (const e of events) writer.write({ type: "data-handoff", data: e });
        const fixed = fixedReply(action);
        if (fixed) {
          writer.write({ type: "text-start", id: "reply" });
          writer.write({ type: "text-delta", id: "reply", delta: fixed });
          writer.write({ type: "text-end", id: "reply" });
          return;
        }
        if (forced) {
          writer.write({ type: "text-start", id: "lead" });
          writer.write({ type: "text-delta", id: "lead", delta: forced.lead });
          writer.write({ type: "text-end", id: "lead" });
        }
        let emitted = events.length;
        const result = streamText({
          model: chatModel(this.env, { session: this.name, agent: "supervisor" }),
          system: systemPrompt(user, this.state, action, detect.secret(lastUserText)),
          messages: modelMessages,
          tools,
          activeTools: forced ? [forced.tool] : TOOLS_FOR[action.kind],
          // A card action is exactly one forced tool call; the card (client tool / approval) ends the turn.
          ...(forced ? { toolChoice: { type: "tool" as const, toolName: forced.tool } } : {}),
          stopWhen: isStepCount(forced ? 1 : 5),
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

  /** The access card's reason field. Validated; only while a draft is open. */
  @callable()
  async updateAccessDraft(edit: unknown) {
    const s = this.state;
    if (!s.accessDraft) return { ok: false, error: "There's no open access request to edit." };
    const parsed = z.object({ justification: justificationSchema }).safeParse(edit);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid reason" };
    this.setState({ ...s, accessDraft: { ...s.accessDraft, justification: parsed.data.justification } });
    return { ok: true };
  }

  /**
   * The password code card calls this directly (not as a chat message), so the code never enters the
   * transcript or the model's context. Attempts are limited in D1.
   */
  @callable()
  async checkResetCode(code: unknown) {
    const s = this.state;
    const owner = await this.owner();
    if (!owner || !s.passwordReset || s.passwordReset.stage !== "code_sent") return { ok: false, error: "There's no code waiting. Ask to reset your password again." };
    if (typeof code !== "string" || !/^\s*\d{6}\s*$/.test(code)) return { ok: false, error: "Enter the 6-digit code from the email." };
    const r = await verifyResetCode(this.env, { resetId: s.passwordReset.id, userId: owner.user_id, code });
    if (r.ok) {
      this.setState({ ...this.state, passwordReset: { ...s.passwordReset, stage: "verified" } });
      return { ok: true };
    }
    const error = {
      wrong: `That code isn't right.${"attemptsLeft" in r ? ` ${r.attemptsLeft} ${r.attemptsLeft === 1 ? "try" : "tries"} left.` : ""}`,
      expired: "That code has expired.",
      too_many: "Too many wrong codes.",
      not_found: "This reset is no longer active.",
    }[r.reason];
    return { ok: false, error, final: r.reason !== "wrong" };
  }

  /** Spike/diagnostics: proves a sub-agent hand-off round-trips (used by tests and /api/health/subagents). */
  async pingSpecialist(message: string) {
    const { PingAgent } = await import("./specialists/ping-agent");
    return this.runAgentTool<{ message: string }, { echo: string; at: number }>(PingAgent, { input: { message } });
  }

  // ───────────────────────────── 24 h follow-up ─────────────────────────────

  /**
   * Schedules a check-in when the assistant fixes something, and cancels it if the conversation turns
   * into a ticket or an escalation first. One per conversation.
   */
  private async syncFollowUp(action: NextAction) {
    const s = this.state;
    const f = s.followUp;
    if (action.kind === "resolved" && s.resolvedByAssistant && !s.ticketNumber && !f) {
      const hours = Number(this.env.FOLLOW_UP_HOURS ?? 24);
      const delay = Math.max(60, Math.round(hours * 3600));
      const topic = s.articleTitle ?? "the fix";
      const sched = await this.schedule(delay, "followUp", { topic });
      this.setState({ ...this.state, followUp: { scheduleId: sched.id, topic, dueAt: Date.now() + delay * 1000, sent: false } });
    } else if (f && !f.sent && (action.kind === "escalate" || s.ticketNumber)) {
      await this.cancelSchedule(f.scheduleId);
      this.setState({ ...this.state, followUp: null });
    }
  }

  /** Scheduled callback: adds a check-in message to the chat and emails the employee. */
  async followUp(payload: { topic: string }) {
    const s = this.state;
    if (!s.followUp || s.followUp.sent || s.ticketNumber || !s.resolvedByAssistant) return;
    const owner = await this.owner();
    if (!owner) return;
    const sentAt = Date.now();
    const message = {
      id: `followup-${sentAt}`,
      role: "assistant" as const,
      parts: [
        { type: "text" as const, text: `Hi ${owner.name.split(" ")[0]} — checking in on yesterday's fix (${payload.topic}). Is it still working?` },
        { type: "data-followup" as const, data: { topic: payload.topic, sentAt } },
      ],
    };
    await this.persistMessages([...(this.messages as UIMessage[]), message as unknown as UIMessage]);
    this.setState({ ...this.state, followUp: { ...s.followUp, sent: true } });
    try {
      await sendEmail(this.env, chatFollowUp(this.env, owner.email, owner.name, payload.topic, this.name));
    } catch (e) {
      console.warn("[supervisor] follow-up email failed:", e instanceof Error ? e.message : e);
    }
    await this.env.DB.prepare(
      `INSERT INTO agent_runs (id, session_id, user_id, agent, route_method, reason, status, summary, duration_ms, created_at)
       VALUES (?, ?, ?, 'followup', 'rules', 'resolved 24 h ago', 'completed', ?, 0, ?)`,
    )
      .bind(crypto.randomUUID(), this.name, owner.user_id, payload.topic, sentAt)
      .run();
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
