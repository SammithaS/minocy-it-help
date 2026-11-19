import { Hono } from "hono";
import { logger } from "hono/logger";
import { authRoutes } from "./auth";
import { sessionMiddleware, type HonoEnv } from "./context";
import { kbRoutes } from "./kb";

export const api = new Hono<HonoEnv>()
  .basePath("/api")
  .use(logger())
  .get("/health", (c) => c.json({ ok: true }))
  .use(sessionMiddleware)
  .route("/", authRoutes)
  .route("/", kbRoutes)
  .notFound((c) => c.json({ error: "not_found" }, 404))
  .onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

export type ApiType = typeof api;
