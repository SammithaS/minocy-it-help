import { Hono } from "hono";
import { logger } from "hono/logger";
import { authRoutes } from "./auth";
import { requireRole, sessionMiddleware, type HonoEnv } from "./context";
import { kbRoutes } from "./kb";
import { publicRoutes } from "./public";
import { consoleRoutes, ticketRoutes } from "./tickets";

export const api = new Hono<HonoEnv>()
  .basePath("/api")
  .use(logger())
  .get("/health", (c) => c.json({ ok: true }))
  .use(sessionMiddleware)
  // Admin diagnostics: proves supervisor → specialist hand-offs work in this runtime.
  .get("/health/subagents", requireRole("admin"), async (c) => {
    const stub = c.env.SUPPORT_AGENT.getByName("00000000-0000-4000-8000-000000000000") as unknown as {
      pingSpecialist(m: string): Promise<{ status: string; output?: unknown; error?: string }>;
    };
    const started = Date.now();
    const r = await stub.pingSpecialist("ping");
    return c.json({ ...r, ms: Date.now() - started }, r.status === "completed" ? 200 : 500);
  })
  .route("/", publicRoutes)
  .route("/", authRoutes)
  .route("/", kbRoutes)
  .route("/", ticketRoutes)
  .route("/", consoleRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404))
  .onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

export type ApiType = typeof api;
