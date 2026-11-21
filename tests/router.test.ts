import { describe, expect, it } from "vitest";
import { decide, routeByRules } from "../src/agents/router";
import { initialSupportState, type SupportState } from "../src/agents/state";
import { computeSlaDue } from "../src/lib/sla";

const guide: SupportState = {
  ...initialSupportState,
  articleId: "KB-002",
  articlePriority: "MEDIUM",
  steps: [{ order: 1, section: "quick", text: "Toggle Wi-Fi", status: "shown" }],
  currentStep: 1,
};

describe("routeByRules", () => {
  const r = (t: string, s: SupportState = initialSupportState) => routeByRules(t, s)?.agent ?? null;

  it("sends new problems to the Knowledge agent", () => {
    expect(r("my wifi keeps dropping")).toBe("knowledge");
    expect(r("laptop bahut slow hai")).toBe("knowledge");
  });

  it("routes explicit requests to the right specialist", () => {
    expect(r("I need access to Figma for the new project")).toBe("access");
    expect(r("access denied when opening the finance drive")).toBe("access");
    expect(r("I forgot my password")).toBe("password");
    expect(r("I'm locked out of my account")).toBe("password");
    expect(r("what's the status of INC-1031?")).toBe("status");
    expect(r("any update on my ticket")).toBe("status");
  });

  it("puts safety and 'talk to a human' above everything", () => {
    expect(r("battery is swollen and I need access to email")).toBe("ticket");
    expect(r("can I just talk to a person", guide)).toBe("ticket");
  });

  it("treats a yes after an escalation offer as agreeing to a ticket", () => {
    expect(r("yes please", { ...guide, escalationReason: "all_steps_tried" })).toBe("ticket");
    expect(r("yes please", guide)).not.toBe("ticket");
  });

  it("keeps an active guide with the Knowledge agent and leaves small talk to the supervisor", () => {
    expect(r("it's still dropping", guide)).toBe("knowledge");
    expect(r("hi")).toBe("chat");
    expect(r("thanks!")).toBe("chat");
  });

  it("routes a step card's 'raise a ticket instead' straight to the Ticket agent", () => {
    expect(r("I'd rather raise a ticket with IT", guide)).toBe("ticket");
    expect(r("Still not working", guide)).toBe("knowledge");
  });

  it("sends equipment requests to a ticket, bare 'password' to the reset flow, and greetings to chat", () => {
    expect(r("I need a new laptop, mine is 5 years old")).toBe("ticket");
    expect(r("my mouse is broken, need a replacement")).toBe("ticket");
    expect(r("my laptop is slow")).toBe("knowledge");
    expect(r("password")).toBe("password");
    expect(r("Password?")).toBe("password");
    expect(r("hello there")).toBe("chat");
    expect(r("hi team!")).toBe("chat");
  });

  it("leaves one-word / unclear messages for the model to route", () => {
    expect(r("printer")).toBeNull();
  });
});

describe("decide", () => {
  const base = { kind: "find_article" } as const;

  it("creates the ticket once the Ticket agent has a draft", () => {
    const s = { ...guide, ticketDraft: { title: "t", summary: "s", category: "network", priority: "MEDIUM" as const, device: null, stepsTried: [], kbArticleId: null } };
    expect(decide({ route: { agent: "ticket", method: "rules", reason: "x" }, base, state: s, ticketDenied: false, clarifyingQuestion: null })).toEqual({
      kind: "create_ticket",
      safety: false,
    });
  });

  it("acknowledges a cancelled ticket", () => {
    expect(decide({ route: null, base, state: guide, ticketDenied: true, clarifyingQuestion: null }).kind).toBe("ticket_cancelled");
  });

  it("asks the Knowledge agent's clarifying question", () => {
    expect(decide({ route: { agent: "knowledge", method: "rules", reason: "new problem" }, base, state: initialSupportState, ticketDenied: false, clarifyingQuestion: "Which printer?" })).toEqual({
      kind: "clarify",
      question: "Which printer?",
    });
  });

  it("lets the model route when the rules couldn't", () => {
    expect(decide({ route: null, base, state: initialSupportState, ticketDenied: false, clarifyingQuestion: null })).toEqual({ kind: "llm_route" });
  });

  it("answers status questions even after a ticket exists", () => {
    const s = { ...guide, ticketNumber: "INC-1001" };
    expect(decide({ route: { agent: "status", method: "rules", reason: "x" }, base: { kind: "ticket_raised", ticketNumber: "INC-1001" }, state: s, ticketDenied: false, clarifyingQuestion: null }).kind).toBe("status");
  });
});

describe("computeSlaDue", () => {
  // IST = UTC+05:30. 2026-11-20 is a Friday.
  const ist = (iso: string) => new Date(`${iso}+05:30`);

  it("uses calendar time for HIGH/MEDIUM/CRITICAL", () => {
    expect(computeSlaDue(ist("2026-11-20T10:00:00"), 240, false).toISOString()).toBe(ist("2026-11-20T14:00:00").toISOString());
    expect(computeSlaDue(ist("2026-11-21T23:30:00"), 60, false).toISOString()).toBe(ist("2026-11-22T00:30:00").toISOString());
  });

  it("only counts working hours (09–18 IST, Mon–Fri) for LOW", () => {
    // Fri 17:00 + 18 working hours → Fri 1h + Mon 9h + Tue 8h → Tue 17:00.
    expect(computeSlaDue(ist("2026-11-20T17:00:00"), 1080, true).toISOString()).toBe(ist("2026-11-24T17:00:00").toISOString());
    // Saturday → clock starts Monday 09:00 → Tue 18:00.
    expect(computeSlaDue(ist("2026-11-21T11:00:00"), 1080, true).toISOString()).toBe(ist("2026-11-24T18:00:00").toISOString());
    // Before hours on a weekday starts at 09:00 the same day.
    expect(computeSlaDue(ist("2026-11-23T07:30:00"), 60, true).toISOString()).toBe(ist("2026-11-23T10:00:00").toISOString());
  });
});
