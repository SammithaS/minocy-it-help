import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, isStepCount, streamText, type UIMessage } from "ai";
import type { AppEnv } from "../env";
import { chatModel } from "../lib/llm";
import type { Os } from "../rag/search";
import { systemPrompt, type UserContext } from "./prompts";
import { deriveState, detect, initialSupportState, nextAction, type SupportState, type UiMessage } from "./state";
import { buildTools } from "./tools";

interface SessionOwner {
  user_id: string;
  name: string;
  department: string | null;
  location: string | null;
  model: string | null;
  os: string | null;
  asset_tag: string | null;
}

/**
 * One Durable Object per conversation (instance name = chat session id).
 * Messages persist in the DO's SQLite; agent state syncs to the browser over the same WebSocket.
 * Ownership is enforced in the Worker before any request reaches this class (src/agents/routing.ts).
 */
export class SupportAgent extends AIChatAgent<AppEnv, SupportState> {
  initialState = initialSupportState;
  /** A user double-sending shouldn't produce two answers. */
  messageConcurrency = "latest" as const;
  maxPersistedMessages = 300;

  private async owner(): Promise<SessionOwner | null> {
    return this.env.DB.prepare(
      `SELECT s.user_id, u.name, u.department, u.location, d.model, d.os, d.asset_tag
       FROM chat_sessions s JOIN user u ON u.id = s.user_id
       LEFT JOIN devices d ON d.user_id = s.user_id
       WHERE s.id = ? LIMIT 1`,
    )
      .bind(this.name)
      .first<SessionOwner>();
  }

  async onChatMessage(_onFinish: unknown, options?: { abortSignal?: AbortSignal }) {
    const owner = await this.owner();
    const user: UserContext = {
      name: owner?.name ?? "there",
      department: owner?.department ?? null,
      location: owner?.location ?? null,
      device: owner?.model ? { model: owner.model, os: owner.os ?? "windows", assetTag: owner.asset_tag ?? "" } : null,
    };

    // Rebuild guide state from the transcript (button clicks, typed messages) before deciding.
    const messages = this.messages as unknown as UiMessage[];
    const derived = deriveState(this.state, messages);
    const last = messages.at(-1);
    // The turn is either a typed message or a step-card answer (a tool result on the last assistant message).
    const lastStepNote = [...(last?.parts ?? [])]
      .reverse()
      .find((p) => p.type === `tool-reportStepOutcome` && p.state === "output-available");
    const lastUserText =
      last?.role === "user"
        ? last.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ")
        : ((lastStepNote?.output as { note?: string } | undefined)?.note ?? "");
    const action = nextAction(derived, { lastUserText });
    const state: SupportState =
      action.kind === "escalate"
        ? { ...derived, escalationReason: action.reason, suggestedPriority: action.reason === "safety" ? "CRITICAL" : derived.suggestedPriority }
        : derived;
    this.setState(state);
    await this.touchSession(lastUserText, action.kind);

    const tools = buildTools({
      env: this.env,
      os: (owner?.os as Os | null) ?? null,
      getState: () => this.state,
      setState: (s) => this.setState(s),
    });

    const result = streamText({
      model: chatModel(this.env, { session: this.name }),
      system: systemPrompt(user, state, action, detect.secret(lastUserText)),
      messages: await convertToModelMessages(this.messages as UIMessage[]),
      tools,
      // Steps are shown one at a time, and resolved/escalated turns need no more tool calls.
      activeTools:
        action.kind === "find_article"
          ? ["searchKnowledgeBase", "startGuide", "reportStepOutcome", "flagEscalation"]
          : action.kind === "show_step"
            ? ["reportStepOutcome", "flagEscalation"]
            : action.kind === "await_outcome"
              ? ["flagEscalation"]
              : [],
      stopWhen: isStepCount(5),
      abortSignal: options?.abortSignal,
      temperature: 0.3,
    });

    return result.toUIMessageStreamResponse();
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
