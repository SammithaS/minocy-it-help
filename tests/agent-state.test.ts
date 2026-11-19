import { describe, expect, it } from "vitest";
import {
  deriveState,
  detect,
  initialSupportState,
  nextAction,
  STEP_TOOL,
  type SupportState,
  type UiMessage,
  type UiPart,
} from "../src/agents/state";
import { systemPrompt } from "../src/agents/prompts";

const guide = (priority: SupportState["articlePriority"] = "MEDIUM", n = 4): SupportState => ({
  ...initialSupportState,
  articleId: "KB-002",
  articleTitle: "Wi-Fi keeps dropping",
  articlePriority: priority,
  ticketCategory: "network",
  steps: Array.from({ length: n }, (_, i) => ({ order: i + 1, section: "quick" as const, text: `Step ${i + 1}`, status: "pending" as const })),
});

let id = 0;
const user = (text: string): UiMessage => ({ id: `m${id++}`, role: "user", parts: [{ type: "text", text }] });
const step = (n: number, outcome?: "worked" | "failed", note?: string): UiPart => ({
  type: `tool-${STEP_TOOL}`,
  toolCallId: `t${n}`,
  input: { stepNumber: n },
  state: outcome ? "output-available" : "input-available",
  output: outcome ? { outcome, note } : undefined,
});
const assistant = (...parts: UiPart[]): UiMessage => ({ id: `m${id++}`, role: "assistant", parts });

describe("deriveState", () => {
  it("replays step outcomes from the transcript", () => {
    const s = deriveState(guide(), [user("wifi drops"), assistant(step(1, "failed")), assistant(step(2))]);
    expect(s.steps.map((x) => x.status)).toEqual(["failed", "shown", "pending", "pending"]);
    expect(s.currentStep).toBe(2);
    expect(s.failedCount).toBe(1);
    expect(s.resolvedByAssistant).toBe(false);
  });

  it("marks the conversation resolved when a step worked", () => {
    const s = deriveState(guide(), [assistant(step(1, "failed")), assistant(step(2, "worked"))]);
    expect(s.resolvedByAssistant).toBe(true);
  });

  it("counts frustration and bumps priority for many users or safety", () => {
    const s = deriveState(guide("MEDIUM"), [user("this is useless"), user("still broken, the whole floor is down!!!")]);
    expect(s.frustrationCount).toBe(2);
    expect(s.suggestedPriority).toBe("HIGH");
    expect(deriveState(guide("LOW"), [user("I spilled coffee on it")]).suggestedPriority).toBe("CRITICAL");
  });

  it("is idempotent (rebuilt from scratch each turn)", () => {
    const msgs = [assistant(step(1, "failed")), assistant(step(2, "failed"))];
    const once = deriveState(guide(), msgs);
    expect(deriveState(once, msgs)).toEqual(once);
  });
});

describe("nextAction", () => {
  it("searches first when no guide is active", () => {
    expect(nextAction(initialSupportState, { lastUserText: "wifi keeps dropping" })).toEqual({ kind: "find_article" });
  });

  it("shows steps one at a time and waits for the answer", () => {
    expect(nextAction(deriveState(guide(), []), { lastUserText: "" })).toEqual({ kind: "show_step", stepNumber: 1 });
    expect(nextAction(deriveState(guide(), [assistant(step(1))]), { lastUserText: "" })).toEqual({ kind: "await_outcome", stepNumber: 1 });
    expect(nextAction(deriveState(guide(), [assistant(step(1, "failed"))]), { lastUserText: "" })).toEqual({ kind: "show_step", stepNumber: 2 });
  });

  it("resolves when a step worked", () => {
    expect(nextAction(deriveState(guide(), [assistant(step(1, "worked"))]), { lastUserText: "" })).toEqual({ kind: "resolved" });
  });

  it("escalates when every step was tried", () => {
    const msgs = [1, 2, 3].map((n) => assistant(step(n, "failed")));
    expect(nextAction(deriveState(guide("MEDIUM", 3), msgs), { lastUserText: "" })).toEqual({ kind: "escalate", reason: "all_steps_tried" });
  });

  it("escalates after 2 failed steps on a HIGH priority issue", () => {
    const msgs = [assistant(step(1, "failed")), assistant(step(2, "failed"))];
    expect(nextAction(deriveState(guide("HIGH"), msgs), { lastUserText: "" })).toEqual({ kind: "escalate", reason: "failed_high_priority" });
    expect(nextAction(deriveState(guide("MEDIUM"), msgs), { lastUserText: "" }).kind).toBe("show_step");
  });

  it("escalates when the user asks for a person or a ticket", () => {
    for (const t of ["can I talk to a human?", "please raise a ticket", "I'd rather raise a ticket with IT", "speak to someone from the IT team"]) {
      expect(nextAction(deriveState(guide(), []), { lastUserText: t })).toEqual({ kind: "escalate", reason: "user_requested" });
    }
  });

  it("escalates on a safety issue straight away", () => {
    expect(nextAction(initialSupportState, { lastUserText: "my laptop battery looks swollen" })).toEqual({ kind: "escalate", reason: "safety" });
    expect(nextAction(initialSupportState, { lastUserText: "there's a burning smell from the charger" }).kind).toBe("escalate");
  });

  it("escalates after frustration twice", () => {
    const s = deriveState(guide(), [user("this is useless"), user("waste of time honestly")]);
    expect(nextAction(s, { lastUserText: "" })).toEqual({ kind: "escalate", reason: "frustration" });
  });

  it("escalates when there's no relevant guide", () => {
    expect(nextAction({ ...initialSupportState, lastSearchConfident: false }, { lastUserText: "coffee machine broken" })).toEqual({
      kind: "escalate",
      reason: "no_article",
    });
  });

  it("re-opens as 'not satisfied' when the fix didn't hold", () => {
    const s = deriveState(guide(), [assistant(step(1, "worked"))]);
    expect(nextAction(s, { lastUserText: "it's still not working actually" })).toEqual({ kind: "escalate", reason: "not_satisfied" });
  });

  it("keeps an escalation sticky until a ticket exists", () => {
    const s = { ...deriveState(guide(), []), escalationReason: "frustration" as const };
    expect(nextAction(s, { lastUserText: "ok" }).kind).toBe("escalate");
    expect(nextAction({ ...s, ticketNumber: "INC-1001" }, { lastUserText: "ok" })).toEqual({ kind: "ticket_raised", ticketNumber: "INC-1001" });
  });
});

describe("detect", () => {
  it("spots secrets users shouldn't share", () => {
    expect(detect.secret("my password is Hunter2!")).toBe(true);
    expect(detect.secret("otp: 482913")).toBe(true);
    expect(detect.secret("123456-123456-123456-123456-123456-123456-123456-123456")).toBe(true);
    expect(detect.secret("I forgot my password")).toBe(false);
  });

  it("doesn't treat ordinary messages as frustration or safety issues", () => {
    expect(detect.frustration("wifi keeps dropping")).toBe(false);
    expect(detect.safety("battery drains fast")).toBe(false);
    expect(detect.wantsHuman("how do I reset my password")).toBe(false);
  });
});

describe("systemPrompt", () => {
  const ctx = { name: "Ananya Sharma", department: "Finance", location: "Bengaluru", device: { model: "Dell Latitude", os: "windows", assetTag: "MIN-LT-0141" } };

  it("includes device context, safety rules and the directive", () => {
    const p = systemPrompt(ctx, deriveState(guide(), []), { kind: "show_step", stepNumber: 1 }, false);
    expect(p).toContain("Dell Latitude (Windows, asset MIN-LT-0141)");
    expect(p).toContain("NEVER ask for, accept, repeat or store passwords");
    expect(p).toContain("Call reportStepOutcome with stepNumber 1");
  });

  it("warns when the user shared a secret, and gives stop-using advice for safety escalations", () => {
    expect(systemPrompt(ctx, initialSupportState, { kind: "find_article" }, true)).toContain("looks like it contains a password");
    expect(systemPrompt(ctx, initialSupportState, { kind: "escalate", reason: "safety" }, false)).toContain("stop using the device");
  });
});
