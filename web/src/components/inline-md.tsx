import { Fragment, type ReactNode } from "react";

/** Renders the tiny markdown subset used in KB text: **bold** and `code`. No HTML is injected. */
export function InlineMd({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    parts.push(
      tok.startsWith("**") ? (
        <strong key={m.index} className="font-bold text-ink">
          {tok.slice(2, -2)}
        </strong>
      ) : (
        <code key={m.index} className="rounded-md bg-canvas px-1.5 py-0.5 text-[0.9em]">
          {tok.slice(1, -1)}
        </code>
      ),
    );
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}
