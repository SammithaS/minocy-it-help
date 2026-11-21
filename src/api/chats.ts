import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type HonoEnv } from "./context";

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** The signed-in user's own conversations (full-page chat history) and their 👍/👎 per chat. */
export const chatRoutes = new Hono<HonoEnv>()
  .use("/chats", requireRole())
  .use("/chats/*", requireRole())
  .get("/chats", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.title, s.outcome, s.kb_article_id, s.created_at, s.updated_at, f.rating
       FROM chat_sessions s LEFT JOIN feedback f ON f.session_id = s.id AND f.user_id = s.user_id
       WHERE s.user_id = ? AND s.title IS NOT NULL ORDER BY s.updated_at DESC LIMIT 30`,
    )
      .bind(c.get("user")!.id)
      .all<{ id: string; title: string; outcome: string; kb_article_id: string | null; created_at: number; updated_at: number; rating: "up" | "down" | null }>();
    return c.json({
      chats: results.map((r) => ({ id: r.id, title: r.title, outcome: r.outcome, articleId: r.kb_article_id, createdAt: r.created_at, updatedAt: r.updated_at, rating: r.rating })),
    });
  })
  .get("/chats/:id/feedback", idParam, async (c) => {
    const row = await c.env.DB.prepare("SELECT rating, comment FROM feedback WHERE session_id = ? AND user_id = ?")
      .bind(c.req.valid("param").id, c.get("user")!.id)
      .first<{ rating: "up" | "down"; comment: string | null }>();
    return c.json({ feedback: row ?? null });
  })
  .put(
    "/chats/:id/feedback",
    idParam,
    zValidator("json", z.object({ rating: z.enum(["up", "down"]), comment: z.string().trim().max(1000).nullish() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const { rating, comment } = c.req.valid("json");
      const userId = c.get("user")!.id;
      const own = await c.env.DB.prepare("SELECT 1 AS ok FROM chat_sessions WHERE id = ? AND user_id = ?").bind(id, userId).first();
      if (!own) return c.json({ error: "not_found" }, 404);
      await c.env.DB.prepare(
        `INSERT INTO feedback (id, session_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, user_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = excluded.created_at`,
      )
        .bind(crypto.randomUUID(), id, userId, rating, comment || null, Date.now())
        .run();
      return c.json({ feedback: { rating, comment: comment || null } });
    },
  );
