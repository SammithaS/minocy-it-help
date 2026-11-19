import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, ChevronDown, LifeBuoy } from "lucide-react";
import { InlineMd } from "@/components/inline-md";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { articleQuery, osLabel, styleFor } from "@/lib/kb";

export const Route = createFileRoute("/_app/articles/$id")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(articleQuery(params.id)),
  errorComponent: ({ error }) => (
    <Card>
      <p className="font-bold">{error instanceof ApiError && error.status === 404 ? "Guide not found" : "Couldn't load this guide"}</p>
      <Link to="/articles" className="mt-2 inline-block text-sm font-bold text-brand-700">
        Back to guides
      </Link>
    </Card>
  ),
  component: ArticlePage,
});

const isWarning = (p: string) => /^\*\*(safety|never|if liquid|don't|it will never)/i.test(p) || /\*\*(never|stop using)/i.test(p);

function ArticlePage() {
  const { id } = Route.useParams();
  const { data: a } = useSuspenseQuery(articleQuery(id));
  const s = styleFor(a.category);
  const quick = a.steps.filter((x) => x.section === "quick");
  const advanced = a.steps.filter((x) => x.section === "advanced");

  return (
    <article className="mx-auto max-w-3xl space-y-5">
      <Link to="/articles" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-brand-700">
        <ArrowLeft className="size-4" /> All guides
      </Link>

      <header className="flex items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl" style={{ background: s.bg, color: s.fg }}>
          <s.icon className="size-6" strokeWidth={2} />
        </span>
        <div>
          <h1 className="text-2xl font-extrabold leading-tight sm:text-3xl">{a.title}</h1>
          <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-muted">
            <span>{a.id}</span>·<span>{a.category}</span>·<span>{a.os.map((o) => osLabel[o] ?? o).join(", ")}</span>
          </p>
        </div>
      </header>

      {a.intro.map((p, i) =>
        isWarning(p) ? (
          <div key={i} role="note" className="flex gap-3 rounded-card bg-critical-bg p-4 text-sm text-critical">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" strokeWidth={2} />
            <p>
              <InlineMd text={p} />
            </p>
          </div>
        ) : (
          <p key={i} className="text-[15px] leading-relaxed text-muted">
            <InlineMd text={p} />
          </p>
        ),
      )}

      <Card>
        <h2 className="text-lg font-bold">You might see</h2>
        <ul className="mt-3 space-y-2">
          {a.symptoms.map((x, i) => (
            <li key={i} className="flex gap-2.5 text-[15px]">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-700" />
              <InlineMd text={x} />
            </li>
          ))}
        </ul>
      </Card>

      <section>
        <h2 className="mb-3 text-lg font-extrabold">Try these first</h2>
        <ol className="space-y-3">
          {quick.map((step) => (
            <li key={step.order} className="flex gap-3 rounded-tile border border-line bg-card p-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-sm font-extrabold text-brand-800">
                {step.order}
              </span>
              <p className="pt-1 text-[15px] leading-relaxed">
                <InlineMd text={step.text} />
              </p>
            </li>
          ))}
        </ol>
      </section>

      {advanced.length > 0 && (
        <details className="group rounded-card border border-line bg-card">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-5 font-bold">
            Still not fixed? Advanced steps
            <ChevronDown className="size-5 text-muted transition-transform group-open:rotate-180" />
          </summary>
          <ol className="space-y-3 px-5 pb-5">
            {advanced.map((step) => (
              <li key={step.order} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-canvas text-xs font-extrabold text-muted">
                  {step.order}
                </span>
                <p className="pt-0.5 text-[15px] leading-relaxed">
                  <InlineMd text={step.text} />
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}

      <Card className="bg-brand-50">
        <div className="flex items-start gap-3">
          <LifeBuoy className="mt-0.5 size-5 shrink-0 text-brand-800" strokeWidth={2} />
          <div>
            <h2 className="font-bold text-brand-800">When to contact IT</h2>
            <ul className="mt-2 space-y-1.5 text-[15px] text-ink">
              {a.escalateWhen.map((x, i) => (
                <li key={i}>
                  • <InlineMd text={x} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </article>
  );
}
