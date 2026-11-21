import { generateText, Output } from "ai";
import { z } from "zod";
import { chatModel } from "../../lib/llm";
import { resolveAccessRequest, type AccessPicker, type AccessResolution } from "../../lib/access";
import { SpecialistAgent } from "./base";

const input = z.object({
  requesterId: z.string().min(1),
  /** The employee's recent messages, oldest first (secrets already filtered). */
  userMessages: z.array(z.string()).min(1).max(20),
});
const output = z.object({
  applicationId: z.string().nullable(),
  applicationName: z.string().nullable(),
  justification: z.string(),
  alreadyHasAccess: z.boolean(),
  openRequest: z.object({ number: z.string(), status: z.string() }).nullable(),
  approver: z.object({ name: z.string(), email: z.string(), kind: z.enum(["manager", "owner_team", "admin"]) }).nullable(),
  requiresApproval: z.boolean(),
  ownerTeam: z.string().nullable(),
  usernameLabel: z.string().nullable(),
  clarifyingQuestion: z.string().nullable(),
  catalog: z.array(z.string()),
  method: z.enum(["rules", "llm", "none"]),
});
export type AccessAgentInput = z.infer<typeof input>;
export type AccessAgentOutput = z.infer<typeof output>;

/**
 * Works out which catalog app an employee wants, whether they already have it or have asked before,
 * who approves it, and their reason. Names in the message are matched by rule (no model call); the
 * model only picks when the rules find none or several.
 */
export class AccessAgent extends SpecialistAgent<AccessAgentInput, AccessAgentOutput> {
  readonly displayName = "Access agent";
  readonly inputSchema = input;
  readonly outputSchema = output;

  protected async run(i: AccessAgentInput): Promise<AccessAgentOutput> {
    const pick: AccessPicker = async ({ messages, catalog }) => {
      const { output: p } = await generateText({
        model: chatModel(this.env, { agent: "access" }),
        temperature: 0,
        output: Output.object({
          schema: z.object({
            applicationId: z.string().nullable().describe("One catalog id, or null if none clearly fits"),
            justification: z.string().max(300).nullable().describe("The employee's reason in their words, or null if they gave none"),
            clarifyingQuestion: z.string().max(200).nullable(),
          }),
        }),
        system:
          "You match an employee's access request to ONE app in the company catalog. Only choose from the catalog. " +
          "If it's unclear or not in the catalog, return null and a short question naming the closest catalog apps. Never invent a reason.",
        prompt: [`Employee said:\n${messages.map((m) => `- ${m}`).join("\n")}`, "Catalog:", ...catalog.map((a) => `${a.id}: ${a.name} — ${a.description ?? ""}`)].join("\n"),
      });
      return p;
    };
    const r: AccessResolution = await resolveAccessRequest(this.env, i, pick);
    return r;
  }

  protected summarize(o: AccessAgentOutput) {
    if (!o.applicationName) return "needs the app name";
    if (o.alreadyHasAccess) return `${o.applicationName} · already has access`;
    if (o.openRequest) return `${o.applicationName} · ${o.openRequest.number} already open`;
    return `${o.applicationName} · approver ${o.approver?.name ?? "none needed"}`;
  }
}
