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
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
            APP_URL: "http://localhost",
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
