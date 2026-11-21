/**
 * KbReindexWorkflow — applies one KB revision (editor save or approved proposal), instance id =
 * revision id:  validate → embed chunks (Workers AI) → upsert Vectorize → write D1 (article, steps,
 * FTS) → mark live. Each step retries; a final failure marks the revision "failed" with the error and
 * leaves the live article untouched (D1 is written last).
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../env";
import { articleStatements, contentHash, prepareArticle, validateArticle, vectorRecords, type ArticleMeta } from "../lib/kb-index";
import { embedPassages } from "../rag/embed";

export interface KbReindexParams {
  revisionId: string;
}

interface RevisionRow {
  id: string;
  article_id: string;
  title: string;
  category: string;
  tags: string;
  os: string;
  ticket_category: string;
  priority: string;
  action: string;
  body: string;
  status: string;
}

const RETRY = { retries: { limit: 4, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };

export function revisionMeta(r: RevisionRow): ArticleMeta {
  return {
    id: r.article_id,
    title: r.title,
    category: r.category,
    tags: JSON.parse(r.tags) as string[],
    os: JSON.parse(r.os) as ArticleMeta["os"],
    ticket_category: r.ticket_category as ArticleMeta["ticket_category"],
    priority: r.priority as ArticleMeta["priority"],
    action: r.action as ArticleMeta["action"],
  };
}

export class KbReindexWorkflow extends WorkflowEntrypoint<AppEnv, KbReindexParams> {
  async run(event: WorkflowEvent<KbReindexParams>, step: WorkflowStep) {
    const env = this.env;
    const { revisionId } = event.payload;
    const load = async () => {
      const r = await env.DB.prepare("SELECT * FROM kb_revisions WHERE id = ?").bind(revisionId).first<RevisionRow>();
      if (!r) throw new Error(`revision ${revisionId} not found`);
      return r;
    };

    try {
      const ok = await step.do("validate", RETRY, async () => {
        const r = await load();
        const v = validateArticle({ ...revisionMeta(r), body: r.body });
        if (!v.ok) {
          await env.DB.prepare("UPDATE kb_revisions SET status = 'failed', error = ? WHERE id = ?").bind(v.error, revisionId).run();
          return false;
        }
        await env.DB.prepare("UPDATE kb_revisions SET status = 'indexing', error = NULL WHERE id = ?").bind(revisionId).run();
        return true;
      });
      if (!ok) return { outcome: "invalid" };

      const vectors = await step.do("embed", RETRY, async () => {
        const r = await load();
        const p = prepareArticle(revisionMeta(r), r.body);
        return embedPassages(env.AI, p.chunks.map((c) => c.text));
      });

      await step.do("vectorize", RETRY, async () => {
        const r = await load();
        await env.VECTORIZE.upsert(vectorRecords(prepareArticle(revisionMeta(r), r.body), vectors));
        return "upserted";
      });

      await step.do("d1", RETRY, async () => {
        const r = await load();
        const p = prepareArticle(revisionMeta(r), r.body);
        const now = Date.now();
        await env.DB.batch([
          ...articleStatements(env.DB, p, await contentHash(p.meta, p.body), "console", now),
          env.DB.prepare("UPDATE kb_revisions SET status = 'superseded' WHERE article_id = ? AND status = 'live' AND id != ?").bind(r.article_id, revisionId),
          env.DB.prepare("UPDATE kb_revisions SET status = 'live', applied_at = ?, error = NULL WHERE id = ?").bind(now, revisionId),
        ]);
        return "live";
      });
      return { outcome: "live" };
    } catch (e) {
      await step.do("mark-failed", async () => {
        await env.DB.prepare("UPDATE kb_revisions SET status = 'failed', error = ? WHERE id = ?")
          .bind(String(e instanceof Error ? e.message : e).slice(0, 500), revisionId)
          .run();
        return "failed";
      });
      return { outcome: "failed" };
    }
  }
}

/** Saves a revision and starts its workflow. Returns the revision id. */
export async function saveRevision(
  env: AppEnv,
  input: ArticleMeta & { body: string },
  by: { authorId: string | null; source: "editor" | "proposal"; proposalId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO kb_revisions (id, article_id, title, category, tags, os, ticket_category, priority, action, body, status, author_id, source, proposal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.id,
      input.title,
      input.category,
      JSON.stringify(input.tags),
      JSON.stringify(input.os),
      input.ticket_category,
      input.priority,
      input.action,
      input.body,
      by.authorId,
      by.source,
      by.proposalId ?? null,
      Date.now(),
    )
    .run();
  await env.KB_REINDEX_WORKFLOW.create({ id, params: { revisionId: id } });
  return id;
}
