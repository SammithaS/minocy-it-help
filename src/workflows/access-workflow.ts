/**
 * AccessRequestWorkflow — one instance per access request (instance id = request id):
 *
 *   email approver (signed Approve/Reject links) + tell the requester
 *   → wait "access-decision" (ACCESS_APPROVAL_DAYS, default 7) ── timeout → EXPIRED, tell requester
 *   → rejected → tell requester
 *   → approved → grant through the app's connector (GitHub / Okta / Atlassian)
 *        active  → verify → record grant → tell requester + FYI to the owner team
 *        pending → (GitHub invite) tell requester to accept → re-check at 10 min, 1 h, 6 h, then daily ≤ 7 days
 *        failed  → ticket for the app's team with the connector's error → tell requester
 *
 * Apps that don't need approval skip straight to provisioning. D1 is the source of truth for the
 * decision (the approval page writes it before signalling), so a decision that arrives before the
 * workflow starts waiting isn't lost. `mode: "provision"` re-runs only provisioning (console Retry).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import * as msg from "../email/access-messages";
import { sendEmail } from "../email/send";
import type { AppEnv } from "../env";
import { ACCESS_DECISION_EVENT, loadAccessContext, recordGrant, setProvisionState, type AccessContext, type AccessDecisionPayload } from "../lib/access";
import { checkAccess, ConnectorError, grantAccess, type GrantResult, type GrantTarget } from "../lib/connectors";
import { createTicket } from "../lib/tickets";

export interface AccessWorkflowParams {
  requestId: string;
  /** "provision" = skip approval and (re)run provisioning for an already-approved request. */
  mode?: "provision";
}

/** When to re-check a pending invite (GitHub invites expire after 7 days). */
const PENDING_CHECKS = ["10 minutes", "50 minutes", "5 hours", "18 hours", "1 day", "1 day", "1 day", "1 day", "1 day", "1 day"] as const;

function targetOf(r: AccessContext): GrantTarget | null {
  if (!r.connector) return null;
  const config = (() => {
    try {
      return JSON.parse(r.connector_config || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  })();
  return { app: { name: r.app_name, connector: r.connector, config }, user: { email: r.requester_email, name: r.requester_name }, externalUsername: r.external_username };
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

    if (event.payload.mode === "provision") return this.provision(step, requestId, ctx);

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
      if (status !== "APPROVED") return { outcome: status.toLowerCase() };
    } else {
      await step.do("auto-approve", RETRY, async () => {
        const now = Date.now();
        await env.DB.prepare("UPDATE access_requests SET status = 'APPROVED', decided_at = ?, decision_note = 'No approval needed for this app', updated_at = ? WHERE id = ? AND status = 'PENDING'")
          .bind(now, now, requestId)
          .run();
        return "approved";
      });
    }

    return this.provision(step, requestId, ctx);
  }

  /** Grant through the app's connector, wait for external acceptance if needed, or raise a ticket. */
  private async provision(step: WorkflowStep, requestId: string, ctx: () => Promise<AccessContext>) {
    const env = this.env;
    const target = await step.do("load-target", async () => {
      const r = await ctx();
      await setProvisionState(env, requestId, "PROVISIONING", null);
      return targetOf(r);
    });

    let result: GrantResult;
    if (!target) result = { status: "failed", detail: "This app has no access connector configured." };
    else {
      try {
        result = await step.do("grant", RETRY, async () => {
          try {
            return await grantAccess(env, target);
          } catch (e) {
            if (e instanceof ConnectorError && !e.retryable) return { status: "failed", detail: e.message } as GrantResult;
            throw e; // rate limit / outage: let the step retry
          }
        });
      } catch (e) {
        result = { status: "failed", detail: `Still failing after retries: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
      }
    }

    if (result.status === "pending" && target) {
      const pendingDetail = result.detail;
      await step.do("mark-pending", RETRY, async () => {
        await setProvisionState(env, requestId, "PENDING_EXTERNAL", pendingDetail);
        return (await sendEmail(env, msg.accessInvitePending(env, await ctx(), pendingDetail))).status;
      });
      let state: "active" | "pending" | "none" = "pending";
      for (const [i, wait] of PENDING_CHECKS.entries()) {
        await step.sleep(`wait-accept-${i}`, wait);
        state = await step.do(`check-accept-${i}`, RETRY, () => checkAccess(env, target));
        if (state !== "pending") break;
      }
      result =
        state === "active"
          ? { status: "active", detail: pendingDetail.replace(/ — waiting for them to accept\.?$/, " — accepted.") }
          : { status: "failed", detail: state === "pending" ? "The invite wasn't accepted within 7 days." : "The invite was declined or cancelled." };
    } else if (result.status === "active" && target) {
      // Trust, but verify: the connector said yes — confirm the access really exists.
      const verified = await step.do("verify", RETRY, () => checkAccess(env, target));
      if (verified !== "active") result = { status: "failed", detail: `${result.detail} But a check afterwards didn't find the access.` };
    }

    if (result.status === "active") {
      const detail = result.detail;
      await step.do("record-grant", RETRY, async () => {
        await recordGrant(env, requestId, detail);
        return "provisioned";
      });
      await step.do("email-granted", RETRY, async () => (await sendEmail(env, msg.accessGranted(env, await ctx()))).status);
      await step.do("email-owner-team", RETRY, async () => {
        const m = msg.accessProvisionedTeam(env, await ctx());
        return m ? (await sendEmail(env, m)).status : "no team mailbox";
      });
      return { outcome: "provisioned" };
    }

    const failDetail = result.detail;
    const ticket = await step.do("failure-ticket", RETRY, async () => {
      const r = await ctx();
      if (r.failure_ticket && r.status === "FAILED") return r.failure_ticket;
      const cat = await env.DB.prepare("SELECT category FROM routing_rules WHERE team_id = ? LIMIT 1")
        .bind(r.owner_team_id ?? "")
        .first<{ category: string }>();
      const t = await createTicket(env, {
        requesterId: r.requester_id,
        title: `Set up ${r.app_name} access for ${r.requester_name} (${r.number})`.slice(0, 120),
        description:
          `${r.number} was approved, but automatic provisioning failed:\n\n${failDetail}\n\n` +
          `Grant the access manually, or fix the connector and use Retry on the request in the console.` +
          (r.external_username ? `\n\nAccount name given: ${r.external_username}` : ""),
        category: (cat?.category ?? "identity") as never,
        priority: "MEDIUM",
        source: "PORTAL",
        escalationReason: "provisioning_failed",
      });
      await setProvisionState(env, requestId, "FAILED", failDetail, { failureTicket: t.number });
      return t.number;
    });
    await step.do("email-failed", RETRY, async () => (await sendEmail(env, msg.accessProvisionFailed(env, await ctx(), ticket))).status);
    return { outcome: "failed", ticket };
  }
}
