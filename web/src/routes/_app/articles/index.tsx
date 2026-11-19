import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Loader2, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { InlineMd } from "@/components/inline-md";
import { Card } from "@/components/ui/card";
import { articlesQuery, searchQuery, styleFor, type ArticleSummary } from "@/lib/kb";

export const Route = createFileRoute("/_app/articles/")({
  validateSearch: z.object({ q: z.string().optional() }),
  loader: ({ context }) => context.queryClient.ensureQueryData(articlesQuery),
  component: Articles,
});

function Articles() {
  const { q = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [text, setText] = useState(q);
  const articles = useQuery(articlesQuery);
  const search = useQuery(searchQuery(q));

  function submit(e: FormEvent) {
    e.preventDefault();
    void navigate({ search: { q: text.trim() || undefined } });
  }

  const byCategory = (articles.data ?? []).reduce<Record<string, ArticleSummary[]>>((acc, a) => {
    (acc[a.category] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Guides</h1>
        <p className="text-sm text-muted">Step-by-step fixes from the IT team.</p>
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 rounded-[18px] border border-control bg-card p-2">
        <Search className="ml-2 size-5 shrink-0 text-muted" strokeWidth={2} />
        <label htmlFor="kb-q" className="sr-only">
          Search guides
        </label>
        <input
          id="kb-q"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe the problem, e.g. wifi keeps dropping"
          className="min-h-11 min-w-0 flex-1 bg-transparent px-1 text-[15px] text-ink placeholder:text-muted focus:outline-none"
        />
        <button type="submit" className="min-h-11 rounded-full bg-ink-surface px-5 text-sm font-bold text-white">
          Search
        </button>
      </form>

      {q ? (
        <section aria-live="polite" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">
              Results for “{q}”
            </h2>
            <button type="button" className="text-sm font-bold text-brand-700" onClick={() => void navigate({ search: {} })}>
              Clear
            </button>
          </div>
          {search.isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Searching…
            </p>
          ) : search.isError ? (
            <Card className="text-sm text-critical">Search isn&apos;t available right now. Browse the guides below.</Card>
          ) : search.data.hits.length === 0 || !search.data.confident ? (
            <Card>
              <p className="font-bold">We don&apos;t have a guide for that yet.</p>
              <p className="mt-1 text-sm text-muted">
                The assistant can raise a ticket with the IT team for you.
                {search.data.hits.length > 0 && " These might still help:"}
              </p>
              {search.data.hits.length > 0 && <HitList hits={search.data.hits.slice(0, 3)} />}
            </Card>
          ) : (
            <HitList hits={search.data.hits} />
          )}
        </section>
      ) : null}

      <section className="space-y-6">
        {Object.entries(byCategory).map(([category, list]) => {
          const s = styleFor(category);
          return (
            <div key={category}>
              <h2 className="mb-3 text-lg font-extrabold">{category}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((a) => (
                  <Link
                    key={a.id}
                    to="/articles/$id"
                    params={{ id: a.id }}
                    className="flex items-start gap-3 rounded-tile border border-line bg-card p-4 transition-colors hover:border-control"
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: s.bg, color: s.fg }}>
                      <s.icon className="size-5" strokeWidth={2} />
                    </span>
                    <span>
                      <span className="block text-[15px] font-bold leading-snug">{a.title}</span>
                      <span className="mt-0.5 block text-[13px] text-muted">{a.id}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        {articles.data?.length === 0 && (
          <Card className="text-sm text-muted">No guides yet. An IT admin needs to run the KB ingestion.</Card>
        )}
      </section>
    </div>
  );
}

function HitList({ hits }: { hits: { articleId: string; title: string; snippet: string; category: string }[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {hits.map((h) => (
        <li key={h.articleId}>
          <Link
            to="/articles/$id"
            params={{ id: h.articleId }}
            className="group flex items-start justify-between gap-3 rounded-tile border border-line bg-card p-4 hover:border-control"
          >
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{h.title}</span>
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-800">{h.articleId}</span>
              </span>
              <span className="mt-1 line-clamp-2 block text-sm text-muted">
                <InlineMd text={h.snippet} />
              </span>
            </span>
            <ArrowRight className="mt-1 size-4 shrink-0 text-muted group-hover:text-brand-700" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
