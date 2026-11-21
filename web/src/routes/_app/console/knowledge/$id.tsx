import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Loader2, Save } from "lucide-react";
import { useState } from "react";
import { ArticleForm, isValidDraft, TEMPLATE } from "@/components/console/article-form";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { apiFetch, ApiError } from "@/lib/api";
import { kbArticleQuery, kbListQuery, type ArticleDraft } from "@/lib/console";
import { timeAgo } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { REVISION_LABEL } from "./index";

export const Route = createFileRoute("/_app/console/knowledge/$id")({
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: EditorPage,
});

/** KB editor: saving creates a revision that KbReindexWorkflow embeds and publishes. */
function EditorPage() {
  const { id: param } = Route.useParams();
  const isNew = param === "new";
  const list = useQuery({ ...kbListQuery, enabled: isNew });
  const { data, isPending } = useQuery({
    ...kbArticleQuery(param),
    enabled: !isNew,
    // Poll while a saved revision is being re-indexed.
    refetchInterval: (q) => (q.state.data?.revisions.some((r) => r.status === "pending" || r.status === "indexing") ? 2500 : false),
  });
  if (isNew) {
    const id = list.data?.nextId;
    if (!id) return <p className="text-sm text-muted">Loading…</p>;
    const blank: ArticleDraft = { id, title: "New guide title", category: "Software", tags: [], os: ["windows", "macos"], ticket_category: "software", priority: "MEDIUM", action: "troubleshoot", body: TEMPLATE("New guide title") };
    return <Editor key={id} initial={blank} isNew data={undefined} />;
  }
  if (isPending || !data) return <p className="text-sm text-muted">Loading…</p>;
  return <Editor key={param} initial={data.article} isNew={false} data={data} />;
}

function Editor({ initial, isNew, data }: { initial: ArticleDraft; isNew: boolean; data: Awaited<ReturnType<NonNullable<ReturnType<typeof kbArticleQuery>["queryFn"]>>> | undefined }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ArticleDraft>(initial);

  const save = useMutation({
    mutationFn: (d: ArticleDraft) => apiFetch<{ ok: true; revisionId: string }>(`/console/kb/${d.id}`, { method: "PUT", body: JSON.stringify(d) }),
    onSuccess: async (_r, d) => {
      await qc.invalidateQueries({ queryKey: ["console", "kb"] });
      if (isNew) void navigate({ to: "/console/knowledge/$id", params: { id: d.id }, replace: true });
    },
  });

  const busy = data?.revisions.some((r) => r.status === "pending" || r.status === "indexing");
  const saveError = save.error instanceof ApiError ? (safeError(save.error.message) ?? "Couldn't save.") : save.error ? "Couldn't save." : null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to="/console/knowledge" search={{ tab: "articles", status: "pending" }} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
        <ArrowLeft className="size-4" /> Knowledge base
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-muted">{draft.id}</p>
          <h1 className="text-2xl font-extrabold">{isNew ? "New guide" : draft.title}</h1>
          {!isNew && data?.managedBy === "file" && (
            <p className="mt-1 text-sm text-muted">
              Comes from <code>kb/{draft.id}-….md</code>. Saving here makes the console the source of truth; <code>pnpm kb:ingest</code> won&apos;t overwrite it unless run with{" "}
              <code>--force</code>.
            </p>
          )}
        </div>
        {!isNew && data?.live && (
          <Link to="/articles/$id" params={{ id: draft.id }} target="_blank" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
            View live <ExternalLink className="size-4" />
          </Link>
        )}
      </div>

      <Card>
        <ArticleForm value={draft} onChange={setDraft} />
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !isValidDraft(draft)}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save &amp; re-index
          </Button>
          {busy && (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Re-indexing — embeddings, search index, then live
            </span>
          )}
          {saveError && (
            <p role="alert" className="text-sm text-critical">
              {saveError}
            </p>
          )}
        </div>
      </Card>

      {!isNew && data && data.revisions.length > 0 && (
        <Card>
          <CardTitle>History</CardTitle>
          <ul className="mt-3 divide-y divide-line text-sm">
            {data.revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", REVISION_LABEL[r.status].tone)}>{REVISION_LABEL[r.status].text}</span>
                <span>
                  {r.source === "proposal" ? "Approved proposal" : "Edit"} by {r.author ?? "someone"} · {timeAgo(r.created_at)}
                </span>
                {r.error && <span className="w-full text-xs text-critical">{r.error}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** API errors come back as JSON text; show the validation message when there is one. */
function safeError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return typeof j.error === "string" ? j.error : null;
  } catch {
    return null;
  }
}
