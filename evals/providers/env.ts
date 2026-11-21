/**
 * Shared Wrangler platform proxy for eval providers: local D1 plus your Cloudflare account's Workers
 * AI / Vectorize / AI Gateway, and secrets from .dev.vars (Gemini key) — the same env the Worker gets.
 */
import { getPlatformProxy } from "wrangler";
import type { AppEnv } from "../../src/env";

let proxy: ReturnType<typeof getPlatformProxy<AppEnv>> | undefined;

export async function evalEnv(): Promise<AppEnv> {
  proxy ??= getPlatformProxy<AppEnv>({ configPath: "wrangler.jsonc" });
  return (await proxy).env;
}
