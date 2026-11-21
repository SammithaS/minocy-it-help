/**
 * The Ticket agent's drafting logic, free of Durable Object / Agents SDK imports so it also runs in
 * Node (the ticket-quality eval). The facet class in ticket-agent.ts calls draftTicket().
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import { PRIORITIES } from "../../db/schema";
import type { AppEnv } from "../../env";
import { chatModel } from "../../lib/llm";
import { TICKET_CATEGORIES } from "../../org-config";

const step = z.object({ order: z.number().int(), text: z.string(), result: z.enum(["worked", "failed"]) });
export const ticketInputSchema = z.object({
  /** User messages in order (the employee's own words). */
  userMessages: z.array(z.string()).max(40),
  stepsTried: z.array(step),
  article: z.object({ id: z.string(), title: z.string(), category: z.string() }).nullable(),
  /** Priority from the rules (article priority, bumped for safety / many users). */
  suggestedPriority: z.enum(PRIORITIES).nullable(),
  escalationReason: z.string().nullable(),
  device: z.string().nullable(),
});
export const ticketOutputSchema = z.object({
  title: z.string().min(5).max(120),
  summary: z.string().min(10).max(1500),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(PRIORITIES),
  stepsTried: z.array(step),
  device: z.string().nullable(),
  kbArticleId: z.string().nullable(),
});
export type TicketAgentInput = z.infer<typeof ticketInputSchema>;
export type TicketDraftOutput = z.infer<typeof ticketOutputSchema>;

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;

/** The Ticket agent's one job, as a plain function (also used by the ticket-quality eval). */
export async function draftTicket(env: AppEnv, i: TicketAgentInput): Promise<TicketDraftOutput> {
  const { output: draft } = await generateText({
    model: chatModel(env, { agent: "ticket" }),
    temperature: 0.2,
    output: Output.object({
      schema: z.object({
        title: z.string().max(100).describe("Specific, e.g. 'Wi-Fi drops every few minutes on Dell Latitude (Bengaluru office)'"),
        summary: z.string().max(900).describe("2-4 sentences for the IT engineer: the problem, when it happens, impact. No greetings."),
        category: z.enum(TICKET_CATEGORIES),
        priority: z.enum(PRIORITIES),
      }),
    }),
    system:
      "You write IT support tickets from a chat between an employee and the IT assistant. Be factual and specific; " +
      "never include passwords, codes or recovery keys even if the employee typed them. " +
      "Categories: network (Wi-Fi, VPN, shared drives), hardware (laptop, battery, printer, monitor, peripherals), " +
      "software (installs, app crashes), identity (passwords, MFA, access, phishing, BitLocker), collaboration (Outlook, Teams, OneDrive). " +
      "Priority: CRITICAL = safety risk or many people blocked; HIGH = one person fully blocked; MEDIUM = degraded; LOW = minor/how-to.",
    prompt: [
      `Employee said:\n${i.userMessages.map((m) => `- ${m}`).join("\n")}`,
      i.article ? `Guide followed: ${i.article.id} ${i.article.title} (category ${i.article.category})` : "No guide matched.",
      i.stepsTried.length ? `Steps tried:\n${i.stepsTried.map((s) => `${s.order}. ${s.text} → ${s.result}`).join("\n")}` : "",
      i.escalationReason ? `Why it's being escalated: ${i.escalationReason}` : "",
      i.device ? `Device: ${i.device}` : "",
      i.suggestedPriority ? `Rules suggest priority ${i.suggestedPriority}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  // The guide's category wins (it's curated); priority never goes below what the rules suggest.
  const category = (i.article?.category as TicketDraftOutput["category"] | undefined) ?? draft.category;
  const priority =
    i.suggestedPriority && RANK[i.suggestedPriority] > RANK[draft.priority] ? i.suggestedPriority : draft.priority;

  return {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    category: TICKET_CATEGORIES.includes(category) ? category : draft.category,
    priority,
    stepsTried: i.stepsTried,
    device: i.device,
    kbArticleId: i.article?.id ?? null,
  };
}
