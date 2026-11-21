/** Secrets from .dev.vars / `wrangler secret put` that `wrangler types` can't see. */
export interface Secrets {
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  /** Back-office agent budgets (runs per 24 h) and timings. */
  TRIAGE_DAILY_BUDGET?: string;
  CONFIRM_TIMEOUT_DAYS?: string;
  IT_ADMIN_EMAIL?: string;
  /** Days a manager has to approve an access request before it expires (default 7). */
  ACCESS_APPROVAL_DAYS?: string;
  /** Hours after the assistant resolves a problem before it checks in (default 24). */
  FOLLOW_UP_HOURS?: string;
  /** Knowledge-gap agent runs per 24 h (default 50). */
  KB_GAP_DAILY_BUDGET?: string;
  /** Access connectors. GitHub: fine-grained token with Organization → Members: Read & write. */
  GITHUB_TOKEN?: string;
  /** Okta org domain (e.g. acme.okta.com) and an API token — users, password reset, group access. */
  OKTA_DOMAIN?: string;
  OKTA_API_TOKEN?: string;
  /** Atlassian Cloud site (acme.atlassian.net), admin account email and its API token — Jira / Confluence access. */
  ATLASSIAN_SITE?: string;
  ATLASSIAN_EMAIL?: string;
  ATLASSIAN_API_TOKEN?: string;
}

export type AppEnv = Env & Secrets;
