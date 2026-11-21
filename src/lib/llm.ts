/**
 * Chat model: Gemini (your own free-tier key) through Cloudflare AI Gateway, with fallbacks.
 *
 *   1. Gemini Flash-Lite  ─┐ one AI Gateway "universal" request: the gateway tries Flash-Lite, and on
 *   2. Gemini Flash       ─┘ an error, 429 or timeout falls back to Flash (same API format, same key)
 *   3. Workers AI GLM-4.7 — free daily Neurons; used if Gemini is down, rate-limited or unset
 *
 * Gemini calls go through `env.AI.gateway(id).run()`, so the AI binding authenticates to the gateway
 * (no gateway token) and every call shows up in AI Gateway logs/analytics. The `default` gateway is
 * created automatically on first use. Your Gemini key travels as the request's own header (BYOK on
 * the request), so nothing is billed to the Cloudflare account.
 *
 * Flash-Lite is primary because on the free tier it answers in ~4 s with a higher per-minute quota,
 * while Flash took ~9 s and returned 429 after one call during testing.
 *
 * (agents/models/ai-sdk's `createAI` does the same in production, but its gateway options can't be
 * serialised through Wrangler's remote-binding proxy, so it fails in `pnpm dev`. This works in both.)
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AppEnv } from "../env";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";
export const WORKERS_AI_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";

/** Per-leg timeout before the gateway moves on to the next Gemini model. */
const GEMINI_LEG_TIMEOUT_MS = 20_000;
/** How long we wait for a stream to start before falling back to Workers AI. */
const CONNECT_TIMEOUT_MS = 45_000;

const headersToObject = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => (out[k] = v));
  return out;
};

/**
 * A `fetch` for @ai-sdk/google that sends each request through AI Gateway as a universal request
 * with a second Gemini model as the fallback leg.
 */
export function geminiGatewayFetch(env: AppEnv, gatewayId: string, fallbackModel: string, metadata: Record<string, string>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const at = url.pathname.indexOf("/v1beta/");
    if (at === -1) return fetch(input, init);
    const endpoint = url.pathname.slice(at + 1) + url.search; // "v1beta/models/x:streamGenerateContent?alt=sse"
    const headers = {
      ...headersToObject(init?.headers),
      "cf-aig-request-timeout": GEMINI_LEG_TIMEOUT_MS,
      "cf-aig-metadata": metadata,
    };
    const query = init?.body ? JSON.parse(String(init.body)) : {};
    const fallbackEndpoint = endpoint.replace(/models\/[^:]+:/, `models/${fallbackModel}:`);
    const legs = [{ provider: "google-ai-studio", endpoint, headers, query }];
    if (fallbackEndpoint !== endpoint) legs.push({ provider: "google-ai-studio", endpoint: fallbackEndpoint, headers, query });
    return env.AI.gateway(gatewayId).run(legs);
  };
}

/**
 * Tries each model in order until one starts answering. A model that throws (HTTP error, rate
 * limit) or doesn't start streaming within CONNECT_TIMEOUT_MS is skipped; once a stream has started
 * it is the answer.
 */
export function withFallback(models: LanguageModelV4[], onFallback?: (from: LanguageModelV4, error: unknown) => void | Promise<void>): LanguageModelV4 {
  const [primary] = models;
  if (!primary || models.length === 1) return primary!;

  async function attempt<T>(run: (m: LanguageModelV4) => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (const [i, m] of models.entries()) {
      if (signal?.aborted) throw signal.reason;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(m),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${m.modelId} did not respond in ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);
          }),
        ]);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
        console.warn(`[llm] ${m.provider}/${m.modelId} failed, trying next:`, e instanceof Error ? e.message : e);
        if (i < models.length - 1) {
          try {
            await onFallback?.(m, e);
          } catch {
            // Analytics only; never fail the call.
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  return {
    specificationVersion: primary.specificationVersion,
    provider: "minocy-fallback",
    modelId: models.map((m) => m.modelId).join(" → "),
    supportedUrls: primary.supportedUrls,
    doGenerate: (options) => attempt((m) => m.doGenerate(options), options.abortSignal),
    doStream: (options) => attempt((m) => m.doStream(options), options.abortSignal),
  };
}

export function chatModel(env: AppEnv, metadata: Record<string, string> = {}): LanguageModel {
  const gatewayId = env.AI_GATEWAY_ID || "default";
  const workersAi = createWorkersAI({ binding: env.AI })(WORKERS_AI_FALLBACK_MODEL) as unknown as LanguageModelV4;
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return workersAi;

  const google = createGoogleGenerativeAI({
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    fetch: geminiGatewayFetch(env, gatewayId, env.GEMINI_FALLBACK_MODEL || DEFAULT_GEMINI_FALLBACK_MODEL, {
      app: "minocy-it-help",
      ...metadata,
    }),
  });
  const gemini = google(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL) as unknown as LanguageModelV4;
  // Each fallback is an agent_runs row (status "fallback") so analytics can show fallbacks per agent.
  const recordFallback = async (from: LanguageModelV4, error: unknown) => {
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, session_id, agent, route_method, reason, status, summary, error, created_at)
       VALUES (?, ?, ?, 'llm', 'model fallback', 'fallback', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), metadata.session ?? null, metadata.agent ?? "unknown", `${from.modelId} → ${WORKERS_AI_FALLBACK_MODEL}`, String(error instanceof Error ? error.message : error).slice(0, 300), Date.now())
      .run();
  };
  return withFallback([gemini, workersAi], recordFallback) as unknown as LanguageModel;
}
