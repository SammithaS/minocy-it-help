import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Loader2, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type Connector = "github" | "okta" | "atlassian";
interface App {
  id: string;
  name: string;
  description: string | null;
  ownerTeamId: string | null;
  ownerTeam: string | null;
  requiresManagerApproval: boolean;
  aliases: string[];
  connector: Connector | null;
  connectorConfig: Record<string, string>;
}
interface AppsResponse {
  apps: App[];
  teams: { id: string; name: string }[];
  configured: Record<Connector, boolean>;
}

const appsQuery = { queryKey: ["console", "apps"], queryFn: () => apiFetch<AppsResponse>("/console/apps") };

const CONNECTORS: { value: Connector; label: string; secret: string; fields: { key: string; label: string; placeholder: string; optional?: boolean }[] }[] = [
  {
    value: "github",
    label: "GitHub — organization / team invite",
    secret: "GITHUB_TOKEN",
    fields: [
      { key: "org", label: "Organization", placeholder: "your-org (as in github.com/your-org)" },
      { key: "team", label: "Team slug (optional)", placeholder: "e.g. engineering", optional: true },
    ],
  },
  {
    value: "okta",
    label: "Okta — add to group",
    secret: "OKTA_DOMAIN + OKTA_API_TOKEN",
    fields: [{ key: "groupId", label: "Okta group id", placeholder: "00g1abcd2EFGH3ijk4l5" }],
  },
  {
    value: "atlassian",
    label: "Jira / Confluence — add to group (invite if new)",
    secret: "ATLASSIAN_SITE + ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN",
    fields: [
      { key: "group", label: "Group", placeholder: "jira-software-users or confluence-users" },
      { key: "products", label: "Products for new users (optional)", placeholder: "jira-software, confluence", optional: true },
    ],
  },
];

const field = "min-h-11 w-full rounded-xl border border-control bg-card px-3 text-sm text-ink focus:border-brand-700 focus:outline-none";
const slug = (name: string) =>
  `app-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}`;

/** Admin: the requestable app catalog and how each app's access is granted. */
export function AppsSettings() {
  const { data } = useQuery(appsQuery);
  const [editing, setEditing] = useState<App | "new" | null>(null);
  if (!data) return null;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Apps &amp; access</CardTitle>
          <CardDescription className="mt-1">Employees can request an app once it has a connector. Access is granted for real through GitHub, Okta or Atlassian.</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus /> Add app
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 text-xs font-semibold">
        {CONNECTORS.map((c) => (
          <span key={c.value} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1", data.configured[c.value] ? "bg-resolved-bg text-resolved" : "bg-canvas text-muted")}>
            {data.configured[c.value] ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
            {c.value === "atlassian" ? "Atlassian" : c.value === "github" ? "GitHub" : "Okta"} {data.configured[c.value] ? "connected" : `— set ${c.secret}`}
          </span>
        ))}
      </div>

      {editing === "new" && <AppForm teams={data.teams} onDone={() => setEditing(null)} />}
      <ul className="divide-y divide-line">
        {data.apps.map((a) =>
          editing !== "new" && editing?.id === a.id ? (
            <li key={a.id} className="py-3">
              <AppForm app={a} teams={data.teams} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{a.name}</span>
                <span className="block text-xs text-muted">
                  {a.connector ? `${CONNECTORS.find((c) => c.value === a.connector)?.label} · ${Object.values(a.connectorConfig).join(" / ")}` : "No connector — not requestable"}
                  {a.ownerTeam ? ` · ${a.ownerTeam}` : ""} · {a.requiresManagerApproval ? "manager approves" : "no approval"}
                </span>
              </span>
              <Button variant="ghost" onClick={() => setEditing(a)}>
                <Pencil /> Edit
              </Button>
            </li>
          ),
        )}
      </ul>
    </Card>
  );
}

function AppForm({ app, teams, onDone }: { app?: App; teams: { id: string; name: string }[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(app?.name ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [aliases, setAliases] = useState((app?.aliases ?? []).join(", "));
  const [ownerTeamId, setOwnerTeamId] = useState(app?.ownerTeamId ?? "");
  const [approval, setApproval] = useState(app?.requiresManagerApproval ?? true);
  const [connector, setConnector] = useState<Connector | "">(app?.connector ?? "");
  const [config, setConfig] = useState<Record<string, string>>(app?.connectorConfig ?? {});
  const spec = CONNECTORS.find((c) => c.value === connector);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/console/apps/${app?.id ?? slug(name)}`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          description: description || null,
          aliases: aliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
          ownerTeamId: ownerTeamId || null,
          requiresManagerApproval: approval,
          connector: connector || null,
          connectorConfig: spec ? Object.fromEntries(spec.fields.map((f) => [f.key, config[f.key] ?? ""])) : {},
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: appsQuery.queryKey });
      onDone();
    },
  });
  const error = save.error instanceof ApiError ? errorText(save.error.message) : save.error ? "Couldn't save." : null;
  const missing = spec?.fields.some((f) => !f.optional && !config[f.key]?.trim());

  return (
    <div className="space-y-3 rounded-2xl border border-line bg-canvas p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-bold text-muted">
          App name
          <input className={cn(field, "mt-1")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. GitHub" />
        </label>
        <label className="text-xs font-bold text-muted">
          Owner team
          <select className={cn(field, "mt-1")} value={ownerTeamId} onChange={(e) => setOwnerTeamId(e.target.value)}>
            <option value="">—</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold text-muted sm:col-span-2">
          Description
          <input className={cn(field, "mt-1")} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="text-xs font-bold text-muted sm:col-span-2">
          Other names people use (comma-separated)
          <input className={cn(field, "mt-1")} value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="e.g. gh, git hub" />
        </label>
        <label className="text-xs font-bold text-muted sm:col-span-2">
          Access is granted by
          <select className={cn(field, "mt-1")} value={connector} onChange={(e) => setConnector(e.target.value as Connector | "")}>
            <option value="">No connector (not requestable)</option>
            {CONNECTORS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {spec?.fields.map((f) => (
          <label key={f.key} className="text-xs font-bold text-muted">
            {f.label}
            <input
              className={cn(field, "mt-1")}
              value={config[f.key] ?? ""}
              placeholder={f.placeholder}
              spellCheck={false}
              onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input type="checkbox" className="size-4 accent-[#1D4ED8]" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
        Manager approves each request
      </label>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending || name.trim().length < 2 || missing}>
          {save.isPending && <Loader2 className="animate-spin" />} Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function errorText(raw: string) {
  try {
    return (JSON.parse(raw) as { error?: string }).error ?? "Couldn't save.";
  } catch {
    return "Couldn't save.";
  }
}
