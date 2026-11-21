import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { PriorityBadge, type Priority } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { apiFetch, ApiError } from "@/lib/api";
import { settingsQuery, type Settings } from "@/lib/console";
import { CATEGORY_LABEL } from "@/lib/tickets";

export const Route = createFileRoute("/_app/console/settings")({
  beforeLoad: ({ context }) => {
    if (context.me.user.role !== "admin") throw redirect({ to: "/console" });
  },
  component: SettingsPage,
});

const PRIORITY_ORDER: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const field = "min-h-11 rounded-xl border border-control bg-card px-3 text-sm text-ink focus:border-brand-700 focus:outline-none";

/** Hours shown to admins; stored as minutes. */
const toHours = (m: number) => Math.round((m / 60) * 100) / 100;

function SettingsPage() {
  const { data, dataUpdatedAt } = useQuery(settingsQuery);
  if (!data) return <p className="text-sm text-muted">Loading settings…</p>;
  return <SettingsForm key={dataUpdatedAt} data={data} />;
}

function SettingsForm({ data }: { data: Settings }) {
  const qc = useQueryClient();
  const [routing, setRouting] = useState<Record<string, string>>(() => Object.fromEntries(data.routing.map((r) => [r.category, r.team_id])));
  const [sla, setSla] = useState<Record<string, { hours: string; working: boolean }>>(() =>
    Object.fromEntries(data.sla.map((s) => [s.priority, { hours: String(toHours(s.minutes)), working: s.workingHoursOnly }])),
  );
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      apiFetch("/console/settings", {
        method: "PUT",
        body: JSON.stringify({
          routing: Object.entries(routing).map(([category, teamId]) => ({ category, teamId })),
          sla: Object.entries(sla).map(([priority, s]) => ({ priority, minutes: Math.round(Number(s.hours) * 60), workingHoursOnly: s.working })),
        }),
      }),
    onSuccess: async () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await qc.invalidateQueries({ queryKey: settingsQuery.queryKey });
    },
  });

  const invalidHours = Object.values(sla).some((s) => !(Number(s.hours) >= 0.25 && Number(s.hours) <= 720));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Settings</h1>
        <p className="text-sm text-muted">Changes apply to new tickets. Existing tickets keep their team and due time.</p>
      </div>

      <Card className="space-y-4">
        <div>
          <CardTitle>Routing</CardTitle>
          <CardDescription className="mt-1">Which team gets each kind of ticket (from the chat, the portal form and email).</CardDescription>
        </div>
        <div className="divide-y divide-line">
          {data.categories.map((c) => (
            <label key={c} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="font-semibold">{CATEGORY_LABEL[c] ?? c}</span>
              <select value={routing[c] ?? ""} onChange={(e) => setRouting((r) => ({ ...r, [c]: e.target.value }))} className={field}>
                <option value="" disabled>
                  Pick a team
                </option>
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.mailbox})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </Card>

      <Card className="space-y-4">
        <div>
          <CardTitle>SLA — time to resolve</CardTitle>
          <CardDescription className="mt-1">
            Reminder at 75 % of the time, escalation to IT admins at 100 % with no response. &quot;Working hours&quot; counts 09:00–18:00 IST, Mon–Fri only.
          </CardDescription>
        </div>
        <div className="divide-y divide-line">
          {PRIORITY_ORDER.filter((p) => sla[p]).map((p) => (
            <div key={p} className="flex flex-wrap items-center gap-3 py-3">
              <PriorityBadge priority={p} className="w-24 justify-center" />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="number"
                  min={0.25}
                  max={720}
                  step={0.25}
                  value={sla[p]!.hours}
                  onChange={(e) => setSla((s) => ({ ...s, [p]: { ...s[p]!, hours: e.target.value } }))}
                  className={`${field} w-24`}
                  aria-label={`${p} hours`}
                />
                hours
              </label>
              <label className="ml-auto flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={sla[p]!.working}
                  onChange={(e) => setSla((s) => ({ ...s, [p]: { ...s[p]!, working: e.target.checked } }))}
                  className="size-4 accent-[#1D4ED8]"
                />
                Working hours only
              </label>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending || invalidHours}>
          {save.isPending ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null} {saved ? "Saved" : "Save changes"}
        </Button>
        {invalidHours && <p className="text-sm text-critical">Each SLA must be between 15 minutes and 30 days.</p>}
        {save.isError && (
          <p role="alert" className="text-sm text-critical">
            {save.error instanceof ApiError ? "That didn't save — check the values." : "Couldn't save. Try again."}
          </p>
        )}
      </div>
    </div>
  );
}
