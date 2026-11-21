import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Loader2, Plug, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { timeAgo } from "@/lib/tickets";

export const Route = createFileRoute("/_app/console/connect")({ component: ConnectPage });

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}
const tokensQuery = { queryKey: ["console", "tokens"], queryFn: () => apiFetch<{ tokens: TokenRow[]; mcpUrl: string }>("/console/tokens") };

/** IT staff connect Claude (Code / Desktop) or an IDE to the IT Ops MCP server with a personal token. */
function ConnectPage() {
  const qc = useQueryClient();
  const { data } = useQuery(tokensQuery);
  const [name, setName] = useState("Claude Code");
  const [fresh, setFresh] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => apiFetch<{ id: string; token: string }>("/console/tokens", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: async (r) => {
      setFresh(r.token);
      await qc.invalidateQueries({ queryKey: tokensQuery.queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`/console/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensQuery.queryKey }),
  });

  const url = data?.mcpUrl ?? `${location.origin}/mcp`;
  const command = `claude mcp add --transport http minocy-itops ${url} --header "Authorization: Bearer ${fresh ?? "<your token>"}"`;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold">
          <Plug className="size-6 text-brand-700" /> Connect Claude
        </h1>
        <p className="text-sm text-muted">
          Work your queue from Claude or your IDE: list your team&apos;s tickets, read one in full (steps tried, triage note, comments) and add internal notes. It sees only
          your teams&apos; tickets.
        </p>
      </div>

      <Card className="space-y-4">
        <CardTitle>1. Create an access token</CardTitle>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="min-w-0 flex-1 basis-52">
            <span className="sr-only">Token name</span>
            <input
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="Where you'll use it, e.g. Claude Code"
              className="min-h-11 w-full rounded-full border border-control bg-card px-4 text-sm text-ink focus:border-brand-700 focus:outline-none"
            />
          </label>
          <Button type="submit" disabled={name.trim().length < 2 || create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Create token
          </Button>
        </form>
        {create.isError && <p className="text-sm text-critical">Couldn&apos;t create a token (max 5 active).</p>}
        {fresh && (
          <div className="rounded-2xl border border-sun bg-sun-50/60 p-4 dark:bg-transparent">
            <p className="text-sm font-bold">Copy it now — you won&apos;t see it again.</p>
            <CopyLine value={fresh} />
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <CardTitle>2. Add the server to Claude</CardTitle>
        <CardDescription>Claude Code (terminal):</CardDescription>
        <CopyLine value={command} />
        <CardDescription>
          Claude Desktop or another MCP client: add a remote (Streamable HTTP) server at <code className="font-semibold text-ink">{url}</code> with the header{" "}
          <code className="font-semibold text-ink">Authorization: Bearer &lt;token&gt;</code>.
        </CardDescription>
        <CardDescription>Then ask things like “What's overdue in my team?” or “Summarise INC-1031 and add a note that I've ordered a new battery.”</CardDescription>
      </Card>

      <Card>
        <CardTitle>Your tokens</CardTitle>
        {!data?.tokens.length ? (
          <p className="mt-2 text-sm text-muted">No active tokens.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="font-semibold">{t.name}</span>
                <code className="text-muted">{t.prefix}…</code>
                <span className="text-muted">
                  created {timeAgo(t.created_at)} · {t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : "never used"}
                </span>
                <Button variant="ghost" className="ml-auto" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>
                  <Trash2 /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl border border-line bg-card p-2">
      <code className="min-w-0 flex-1 px-1 py-1.5 font-mono text-[13px] break-all">{value}</code>
      <button
        type="button"
        aria-label="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard blocked: the text is selectable.
          }
        }}
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink"
      >
        {copied ? <Check className="size-4 text-resolved" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
