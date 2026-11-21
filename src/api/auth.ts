import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { createAuth } from "../lib/auth";
import { mayRequestSignInCode } from "../lib/okta-users";
import { requireRole, type HonoEnv } from "./context";

export const authRoutes = new Hono<HonoEnv>()
  // Sign-in codes only for people who are active in Okta (when Okta is configured); their profile is
  // synced on the way. Same response either way, so the endpoint doesn't reveal who exists.
  .post("/auth/email-otp/send-verification-otp", async (c) => {
    const body = (await c.req.raw.clone().json().catch(() => null)) as { email?: unknown; type?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email : "";
    if (email && body?.type === "sign-in" && !(await mayRequestSignInCode(c.env, email))) return c.json({ success: true });
    return createAuth(c.env).handler(c.req.raw);
  })
  // Better Auth handles everything else under /api/auth/*
  .on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw))
  .get("/me", requireRole(), async (c) => {
    const user = c.get("user")!;
    const db = getDb(c.env.DB);
    const [devices, teams] = await Promise.all([
      db.select().from(schema.devices).where(eq(schema.devices.userId, user.id)),
      db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(eq(schema.teamMembers.userId, user.id)),
    ]);
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department ?? null,
        location: user.location ?? null,
      },
      devices,
      teams,
    });
  });
