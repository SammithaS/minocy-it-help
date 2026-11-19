import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb, schema } from "../db/client";
import { parseSections } from "../rag/kb-sections";
import { searchKb } from "../rag/search";
import { requireRole, type HonoEnv } from "./context";

const osSchema = z.enum(["windows", "macos", "linux"]);

export const kbRoutes = new Hono<HonoEnv>()
  .use("/kb/*", requireRole())
  .get(
    "/kb/search",
    zValidator(
      "query",
      z.object({
        q: z.string().trim().min(2).max(500),
        os: z.union([osSchema, z.literal("any")]).optional(),
        limit: z.coerce.number().int().min(1).max(10).optional(),
      }),
    ),
    async (c) => {
      const { q, os, limit } = c.req.valid("query");
      let filterOs: z.infer<typeof osSchema> | null = os && os !== "any" ? os : null;
      if (!os) {
        // Default to the user's own device OS so they see steps that apply to them.
        const device = await getDb(c.env.DB)
          .select({ os: schema.devices.os })
          .from(schema.devices)
          .where(eq(schema.devices.userId, c.get("user")!.id))
          .get();
        filterOs = device?.os ?? null;
      }
      const result = await searchKb({ db: c.env.DB, ai: c.env.AI, vectorize: c.env.VECTORIZE }, q, { os: filterOs, limit });
      return c.json({ ...result, os: filterOs });
    },
  )
  .get("/kb/articles", async (c) => {
    const rows = await getDb(c.env.DB)
      .select({
        id: schema.kbArticles.id,
        title: schema.kbArticles.title,
        category: schema.kbArticles.category,
        tags: schema.kbArticles.tags,
        os: schema.kbArticles.os,
        ticketCategory: schema.kbArticles.ticketCategory,
        action: schema.kbArticles.action,
      })
      .from(schema.kbArticles)
      .orderBy(asc(schema.kbArticles.id));
    return c.json({ articles: rows });
  })
  .get("/kb/articles/:id", zValidator("param", z.object({ id: z.string().regex(/^KB-\d{3}$/) })), async (c) => {
    const { id } = c.req.valid("param");
    const row = await getDb(c.env.DB).select().from(schema.kbArticles).where(eq(schema.kbArticles.id, id)).get();
    if (!row) return c.json({ error: "not_found" }, 404);
    const s = parseSections(row.body);
    return c.json({
      article: {
        id: row.id,
        title: row.title,
        category: row.category,
        tags: row.tags,
        os: row.os,
        ticketCategory: row.ticketCategory,
        priority: row.priority,
        action: row.action,
        intro: s.intro,
        symptoms: s.symptoms,
        steps: s.steps,
        escalateWhen: s.escalateWhen,
        updatedAt: row.updatedAt,
      },
    });
  });
