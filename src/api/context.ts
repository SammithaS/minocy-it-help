import { createMiddleware } from "hono/factory";
import type { Role } from "../db/schema";
import type { AppEnv } from "../env";
import { createAuth, type SessionUser } from "../lib/auth";

export type HonoEnv = {
  Bindings: AppEnv;
  Variables: { user: SessionUser | null };
};

/** Loads the Better Auth session (if any) into `c.var.user`. */
export const sessionMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  await next();
});

/** Requires a signed-in user, optionally with one of the given roles. */
export const requireRole = (...roles: Role[]) =>
  createMiddleware<HonoEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (roles.length > 0 && !roles.includes(user.role as Role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
