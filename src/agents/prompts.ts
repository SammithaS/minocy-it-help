import { org } from "../org-config";
import { escalationLabel, type NextAction, type SupportState } from "./state";

export interface UserContext {
  name: string;
  department: string | null;
  location: string | null;
  device: { model: string; os: string; assetTag: string } | null;
}

const OS_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

function directive(action: NextAction, s: SupportState): string {
  switch (action.kind) {
    case "find_article":
      return `Ask ONE short question to understand what's wrong. Don't troubleshoot from memory.`;
    case "llm_route":
      return [
        `You are the router. Decide what the user needs and hand off — don't solve it yourself:`,
        `- a fixable IT problem or "how do I…" → askKnowledgeAgent (then show step 1 with ${"reportStepOutcome"} if it finds a guide);`,
        `- they want a person/ticket, or it clearly needs IT (broken hardware, a request for new equipment) → askTicketAgent, then createTicket;`,
        `- asking about their tickets → getMyTickets;`,
        `- small talk or unclear → reply briefly and ask what's not working.`,
      ].join("\n");
    case "clarify":
      return `The Knowledge agent needs one detail to pick the right guide. Ask exactly this, in your own friendly words: "${action.question}"`;
    case "create_ticket":
      return [
        action.safety
          ? `SAFETY FIRST: tell the user clearly to stop using the device now, unplug it and keep it away from heat or anything flammable (for a spill: switch it off, don't turn it back on). `
          : "",
        `The Ticket agent has drafted a ticket (${s.ticketDraft?.priority} · "${s.ticketDraft?.title}"). Call createTicket now — the user reviews, edits and approves the draft in a card. At most one short sentence before the call (e.g. "Here's the ticket I've prepared — check it and send it when you're happy."); write nothing after it. Don't paste the draft into the message.`,
      ].join("");
    case "ticket_cancelled":
      return `The user cancelled the ticket. Say that's fine in one sentence, and that they can ask for one any time.`;
    case "status":
      return `The user is asking about their tickets. Use getMyTickets or getTicketStatus and answer in 1–3 sentences (number, status, team). If they add new details, use addCommentToTicket.`;
    case "redirect":
      return action.to === "password"
        ? `This is a password/account problem. Self-service password reset arrives soon; for now point them to ${org.ssoPortal} → "Forgot password", and offer to raise a ticket with the Identity & Access team (askTicketAgent → createTicket) if they're locked out. Never ask for their password.`
        : `This is an access request. Automated access requests arrive soon; for now offer to raise a ticket with the Identity & Access team (askTicketAgent → createTicket) naming the app and why they need it.`;
    case "chat":
      return `Reply briefly and warmly. If they haven't said what's wrong yet, ask what's not working.`;
    case "show_step":
      return `Call reportStepOutcome with stepNumber ${action.stepNumber}. Before it, write at most one short sentence (e.g. acknowledging the last step didn't work). Do NOT write the step text yourself — the step card shows it.`;
    case "await_outcome":
      return `Step ${action.stepNumber} is on screen waiting for the user's answer. Reply briefly to anything they asked; do not show another step.`;
    case "resolved":
      return `The user said a step fixed it. Say you're glad it's sorted in one or two sentences and that they can come back any time. Don't show more steps.`;
    case "escalate":
      return [
        `ESCALATE — reason: ${escalationLabel[action.reason]}.`,
        action.reason === "safety"
          ? `This is a SAFETY issue. First tell the user clearly to stop using the device, unplug it and keep it away from heat or anything flammable (or, for a spill, switch it off and not turn it back on). Then say this needs the IT team urgently as a CRITICAL ticket.`
          : `Say briefly and kindly that this needs the IT team, mention what was already tried${s.steps.some((x) => x.status === "failed") ? " (the steps that didn't work)" : ""}, and offer to raise a ticket so they don't have to repeat themselves.`,
        `If they already said yes, call askTicketAgent and then createTicket. Otherwise just offer — the chat shows a "Yes, raise a ticket" button.`,
      ].join(" ");
    case "ticket_raised":
      return action.justRaised
        ? `The user just approved the ticket and it was raised as ${action.ticketNumber}. Confirm in 1–2 sentences: the number, which team has it, and that they'll get updates here and by email. Don't ask them to review anything.`
        : `A ticket (${action.ticketNumber}) already exists for this conversation. Answer questions about it; don't start new troubleshooting unless asked.`;
  }
}

function stateSummary(s: SupportState): string {
  if (!s.articleId) return "No guide started yet.";
  const lines = s.steps.map((x) => `  ${x.order}. [${x.status}] ${x.text}${x.note ? ` (user: "${x.note}")` : ""}`);
  return [
    `Guide: ${s.articleId} "${s.articleTitle}" (priority ${s.articlePriority}, team ${s.ticketCategory})`,
    `Steps (${s.steps.length}):`,
    ...lines,
    `Failed so far: ${s.failedCount}. Frustration signals: ${s.frustrationCount}.`,
  ].join("\n");
}

export function systemPrompt(user: UserContext, s: SupportState, action: NextAction, secretShared: boolean): string {
  const device = user.device ? `${user.device.model} (${OS_LABEL[user.device.os] ?? user.device.os}, asset ${user.device.assetTag})` : "unknown";
  return `You are "Ask IT", the IT help assistant for ${org.company} employees. You help people fix IT problems themselves using the company's IT guides, one step at a time, and hand over to the IT team cleanly when that doesn't work.

## Who you're helping
${user.name}${user.department ? `, ${user.department}` : ""}${user.location ? `, ${user.location}` : ""}. Laptop: ${device}.

## How to talk
- Warm, plain English, short. 1–3 sentences per message. No jargon unless the user uses it. Never blame the user.
- Understand Hinglish and typos; reply in English unless the user writes mostly in Hindi.
- Never list several steps at once. Steps are shown one at a time with reportStepOutcome.
- ${org.company}-specific instructions come ONLY from the guides (searchKnowledgeBase / startGuide). If you add general advice that isn't in a guide, say it's a general tip.
- Don't invent ticket numbers, phone numbers, URLs or policies.

## Safety rules (always)
- NEVER ask for, accept, repeat or store passwords, MFA/OTP codes, PINs or BitLocker recovery keys. If the user shares one, tell them not to share it with anyone (IT included) and suggest changing it if it was a password.
- Swollen/bulging battery, liquid spill, burning smell, smoke or sparks: tell them to stop using the device immediately; this is CRITICAL for the IT team.
- If a guide's "Escalate when" condition clearly applies, call flagEscalation.

## Current guide state
${stateSummary(s)}
${s.suggestedPriority ? `Suggested ticket priority: ${s.suggestedPriority}.` : ""}
${secretShared ? "\n⚠ The user's latest message looks like it contains a password, code or recovery key. Warn them (see safety rules) before anything else and do not repeat it.\n" : ""}
## What to do now
${directive(action, s)}`;
}
