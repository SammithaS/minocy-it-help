/** Secrets from .dev.vars / `wrangler secret put` that `wrangler types` can't see. */
export interface Secrets {
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  IT_ADMIN_EMAIL?: string;
}

export type AppEnv = Env & Secrets;
