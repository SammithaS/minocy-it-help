import { getAgentByName, type Agent } from "agents";
import type { AppEnv } from "../env";
import { createAuth } from "../lib/auth";

const AGENT_PATH = /^\/agents\/support-agent\/([0-9a-f-]{36})(\/.*)?$/;

/**
 * Routes /agents/support-agent/:sessionId (HTTP + WebSocket) to the SupportAgent Durable Object,
 * after checking the Better Auth session and that the conversation belongs to the caller.
 * A new session id is claimed by the first user who connects to it.
 */
export async function routeSupportAgent(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/agents/")) return null;
  const match = url.pathname.match(AGENT_PATH);
  if (!match) return new Response("Not found", { status: 404 });
  const sessionId = match[1]!;

  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;

  // Claim-or-check ownership in one statement.
  await env.DB.prepare("INSERT INTO chat_sessions (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(sessionId, userId, Date.now(), Date.now())
    .run();
  const row = await env.DB.prepare("SELECT user_id FROM chat_sessions WHERE id = ?").bind(sessionId).first<{ user_id: string }>();
  if (row?.user_id !== userId) return new Response("Forbidden", { status: 403 });

  // The SDK's namespace type can't express a typed `state` getter; the binding is SupportAgent.
  const ns = env.SUPPORT_AGENT as unknown as DurableObjectNamespace<Agent<AppEnv>>;
  const agent = await getAgentByName(ns, sessionId);
  return agent.fetch(request);
}
