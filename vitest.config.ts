import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      agents(),
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests never call real Vectorize/Workers AI — search is tested with fakes.
        remoteBindings: false,
        miniflare: {
          // Facet-backed sub-agents (specialists) need a test-only DO binding so `ctx.exports`
          // yields a facet-compatible class in the test runtime. Not needed in production.
          durableObjects: {
            PING_AGENT: { className: "PingAgent", useSQLite: true },
            KNOWLEDGE_AGENT: { className: "KnowledgeAgent", useSQLite: true },
            TICKET_AGENT: { className: "TicketAgent", useSQLite: true },
            ACCESS_AGENT: { className: "AccessAgent", useSQLite: true },
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
            APP_URL: "http://localhost",
            // Never use real keys or send real mail from tests (overrides .dev.vars).
            GOOGLE_GENERATIVE_AI_API_KEY: "",
            RESEND_API_KEY: "",
            IT_ADMIN_EMAIL: "",
            EMAIL_TRANSPORT: "log",
            // Connector tests fake these APIs with a stubbed fetch. Okta stays off by default because it
            // also gates sign-in; Okta tests pass their own env.
            GITHUB_TOKEN: "test-github-token",
            ATLASSIAN_SITE: "minocy-test.atlassian.net",
            ATLASSIAN_EMAIL: "admin@minocy.example",
            ATLASSIAN_API_TOKEN: "test-atlassian-token",
            OKTA_DOMAIN: "",
            OKTA_API_TOKEN: "",
          },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.test.ts"],
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  };
});
