import { Hono } from "hono";
import { listAccessRequests } from "../lib/access";
import { requireRole, type HonoEnv } from "./context";

/** The employee's own access requests (shown on My tickets & requests). */
export const accessRoutes = new Hono<HonoEnv>().get("/access-requests", requireRole(), async (c) => {
  const rows = await listAccessRequests(c.env, c.get("user")!.id);
  return c.json({
    requests: rows.map((r) => ({
      id: r.id,
      number: r.number,
      application: r.application,
      status: r.status,
      justification: r.justification,
      decisionNote: r.decision_note,
      provisionDetail: r.provision_detail,
      failureTicket: r.failure_ticket,
      approver: r.approver_name ?? r.approver_email,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      provisionedAt: r.provisioned_at,
    })),
  });
});
