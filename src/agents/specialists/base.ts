/**
 * Base class for headless specialist agents (Knowledge, Ticket, Access…).
 *
 * The supervisor (SupportAgent) hands work to a specialist with `runAgentTool(Specialist, { input })`.
 * Each specialist is a facet-backed sub-agent: its own Durable Object storage, transcript and retained
 * runs. It does one job, returns zod-validated JSON, and never talks to the browser directly — anything
 * interactive (step cards, approval cards) stays with the supervisor.
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { z } from "zod";
import type { AppEnv } from "../../env";

interface Envelope {
  runId: string;
  input: unknown;
}

export abstract class SpecialistAgent<I, O> extends AIChatAgent<AppEnv> {
  /** Shown in the chat's hand-off chip and stored in agent_runs. */
  abstract readonly displayName: string;
  abstract readonly inputSchema: z.ZodType<I>;
  abstract readonly outputSchema: z.ZodType<O>;
  /** Does the work. Throwing marks the run as failed; the supervisor falls back gracefully. */
  protected abstract run(input: I): Promise<O>;
  /** One line for the parent run summary. */
  protected abstract summarize(output: O): string;

  maxPersistedMessages = 100;

  private ensureTable() {
    void this.sql`CREATE TABLE IF NOT EXISTS specialist_results (run_id TEXT PRIMARY KEY, output TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  }

  protected override formatAgentToolInput(input: unknown, request: { runId: string }): UIMessage {
    const envelope: Envelope = { runId: request.runId, input };
    return { id: `agent-tool-${request.runId}-input`, role: "user", parts: [{ type: "text", text: JSON.stringify(envelope) }] };
  }

  async onChatMessage() {
    const last = this.messages.at(-1);
    const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
    const envelope = JSON.parse(text) as Envelope;
    const input = this.inputSchema.parse(envelope.input);
    const output = this.outputSchema.parse(await this.run(input));

    this.ensureTable();
    void this.sql`INSERT OR REPLACE INTO specialist_results (run_id, output, created_at) VALUES (${envelope.runId}, ${JSON.stringify(output)}, ${Date.now()})`;

    const summary = this.summarize(output);
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: "summary" });
        writer.write({ type: "text-delta", id: "summary", delta: summary });
        writer.write({ type: "text-end", id: "summary" });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  protected override getAgentToolOutput(request: { runId: string }): unknown {
    this.ensureTable();
    const rows = this.sql<{ output: string }>`SELECT output FROM specialist_results WHERE run_id = ${request.runId}`;
    return rows[0] ? JSON.parse(rows[0].output) : undefined;
  }

  protected override getAgentToolSummary(_request: { runId: string }, output: unknown): string {
    return output ? this.summarize(output as O) : "";
  }
}
