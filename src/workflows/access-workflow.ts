/**
 * AccessRequestWorkflow — one instance per access request (instance id = request id):
 *
 *   email approver (signed Approve/Reject links) + tell the requester
 *   → wait "access-decision" (ACCESS_APPROVAL_DAYS, default 7) ── timeout → EXPIRED, tell requester
 *   → rejected → tell requester
 *   → approved → provision (mock) → tell requester + FYI to the owner team
 *
 * Apps that don't need approval skip straight to provisioning. D1 is the source of truth for the
 * decision (the approval page writes it before signalling), so a decision that arrives before the
 * workflow starts waiting isn't lost.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import * as msg from "../email/access-messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { ACCESS_DECISION_EVENT, loadAccessContext, provisionAccess, type AccessDecisionPayload } from "../lib/access";

export interface AccessWorkflowParams {
  requestId: string;
}

const RETRY = { retries: { limit: 5, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };

export class AccessRequestWorkflow extends WorkflowEntrypoint<AppEnv, AccessWorkflowParams> {
  async run(event: WorkflowEvent<AccessWorkflowParams>, step: WorkflowStep) {
    const env = this.env;
    const { requestId } = event.payload;
    const days = Number(env.ACCESS_APPROVAL_DAYS ?? 7);
    const ctx = async () => {
      const r = await loadAccessContext(env, requestId);
      if (!r) throw new Error(`access request ${requestId} not found`);
      return r;
    };

    const info = await step.do("load", RETRY, async () => {
      const r = await ctx();
      return { number: r.number, needsApproval: !!r.requires_manager_approval && !!r.approver_email };
    });

    if (info.needsApproval) {
      await step.do("email-approver", RETRY, async () => (await sendEmail(env, await msg.accessApprovalRequest(env, await ctx(), days))).status);
      await step.do("email-requester-submitted", RETRY, async () => (await sendEmail(env, msg.accessSubmitted(env, await ctx()))).status);

      const decidedEarly = await step.do("check-decided", async () => (await ctx()).status !== "PENDING");
      let decision: AccessDecisionPayload | null = null;
      if (!decidedEarly) {
        try {
          decision = (await step.waitForEvent<AccessDecisionPayload>("decision", { type: ACCESS_DECISION_EVENT, timeout: `${days} days` })).payload;
        } catch {
          const expired = await step.do("expire", RETRY, async () => {
            const now = Date.now();
            const r = await env.DB.prepare("UPDATE access_requests SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'PENDING' RETURNING id")
              .bind(now, requestId)
              .first();
            if (r) await sendEmail(env, msg.accessNotGranted(env, await ctx(), "expired"));
            return !!r;
          });
          if (expired) return { outcome: "expired" };
        }
      }

      // The approval page records the decision in D1 before signalling; if it somehow hasn't, apply
      // the event's decision (still only while PENDING).
      const status = await step.do("read-decision", async () => {
        const r = await ctx();
        if (r.status !== "PENDING" || !decision) return r.status;
        const next = decision.decision === "approve" ? "APPROVED" : "REJECTED";
        const now = Date.now();
        await env.DB.prepare("UPDATE access_requests SET status = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'")
          .bind(next, decision.note, now, now, requestId)
          .run();
        return (await ctx()).status;
      });
      if (status === "REJECTED") {
        await step.do("email-rejected", RETRY, async () => (await sendEmail(env, msg.accessNotGranted(env, await ctx(), "rejected"))).status);
        return { outcome: "rejected" };
      }
      if (status !== "APPROVED" && status !== "PROVISIONED") return { outcome: status.toLowerCase() };
    } else {
      await step.do("auto-approve", RETRY, async () => {
        const now = Date.now();
        await env.DB.prepare("UPDATE access_requests SET status = 'APPROVED', decided_at = ?, decision_note = 'No approval needed for this app', updated_at = ? WHERE id = ? AND status = 'PENDING'")
          .bind(now, now, requestId)
          .run();
        return "approved";
      });
    }

    await step.do("provision", RETRY, async () => {
      if (!(await provisionAccess(env, requestId))) throw new Error("provisioning failed");
      return "provisioned";
    });
    await step.do("email-granted", RETRY, async () => (await sendEmail(env, msg.accessGranted(env, await ctx()))).status);
    await step.do("email-owner-team", RETRY, async () => {
      const m = msg.accessProvisionedTeam(env, await ctx());
      return m ? (await sendEmail(env, m)).status : "no team mailbox";
    });
    return { outcome: "provisioned" };
  }
}
