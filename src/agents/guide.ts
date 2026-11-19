import type { AppEnv } from "../env";
import type { GuideStep, Priority, SupportState } from "./state";

interface ArticleRow {
  id: string;
  title: string;
  priority: Priority;
  ticket_category: string;
  body: string;
}

/** Loads a KB article's steps into the supervisor state (the guide the user will walk through). */
export async function loadGuide(env: AppEnv, articleId: string, prev: SupportState): Promise<{ state: SupportState; escalateWhen: string[] } | null> {
  const article = await env.DB.prepare("SELECT id, title, priority, ticket_category, body FROM kb_articles WHERE id = ?")
    .bind(articleId)
    .first<ArticleRow>();
  if (!article) return null;
  const { results } = await env.DB.prepare(
    `SELECT section, "order", text FROM kb_steps WHERE article_id = ? ORDER BY CASE section WHEN 'quick' THEN 0 ELSE 1 END, "order"`,
  )
    .bind(articleId)
    .all<{ section: "quick" | "advanced"; order: number; text: string }>();
  const steps: GuideStep[] = results.map((r, i) => ({ order: i + 1, section: r.section, text: r.text, status: "pending" }));
  const escalateWhen = (article.body.split(/^## Escalate when\s*$/m)[1] ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  return {
    escalateWhen,
    state: {
      ...prev,
      articleId,
      articleTitle: article.title,
      articlePriority: article.priority,
      ticketCategory: article.ticket_category,
      suggestedPriority: prev.suggestedPriority ?? article.priority,
      steps,
      currentStep: 0,
      failedCount: 0,
      resolvedByAssistant: false,
      escalationReason: null,
      lastSearchConfident: true,
    },
  };
}
