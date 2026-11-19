import { routeSupportAgent } from "./agents/routing";
import { api } from "./api/app";
import { sendDailyDigest } from "./email/digest";
import { handleInboundEmail } from "./email/inbound";
import type { AppEnv } from "./env";

export { SupportAgent } from "./agents/support-agent";
export { TicketBoard } from "./durable/ticket-board";
export { TriageAgent } from "./agents/triage-agent";
export { TicketWorkflow } from "./workflows/ticket-workflow";
export { KnowledgeAgent } from "./agents/specialists/knowledge-agent";
export { PingAgent } from "./agents/specialists/ping-agent";
export { TicketAgent } from "./agents/specialists/ticket-agent";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }
    const agent = await routeSupportAgent(request, env);
    if (agent) return agent;
    // Static assets / SPA are served by the assets binding before the Worker runs;
    // anything reaching here is an unknown non-API path.
    return new Response("Not found", { status: 404 });
  },

  /** Email Routing: help@ → new ticket, ticket+INC-…@ → comment. */
  async email(message, env) {
    await handleInboundEmail(message, env);
  },

  /** Cron: daily digest to IT admins (09:00 IST). */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sendDailyDigest(env).then((r) => console.log(`[cron] digest sent to ${r.admins} admin(s)`)));
  },
} satisfies ExportedHandler<AppEnv>;
