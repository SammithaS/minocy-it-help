import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Hourglass, Play, ThumbsDown, ThumbsUp, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { assigneesQuery } from "@/lib/console";
import type { Ticket } from "@/lib/tickets";

function useTicketMutation(number: string) {
  const qc = useQueryClient();
  return (path: string, body: unknown) =>
    apiFetch(path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["tickets"] }), qc.invalidateQueries({ queryKey: ["console"] }), qc.invalidateQueries({ queryKey: ["tickets", "detail", number] })]);
      return r;
    });
}

/** IT staff: assign, start work, resolve with a note (each signals the ticket workflow). */
export function StaffActions({ ticket, meId }: { ticket: Ticket; meId: string }) {
  const post = useTicketMutation(ticket.number);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const assign = useMutation({ mutationFn: (assigneeId?: string) => post(`/console/tickets/${ticket.number}/assign`, assigneeId ? { assigneeId } : {}) });
  const start = useMutation({ mutationFn: () => post(`/console/tickets/${ticket.number}/status`, { status: "IN_PROGRESS" }) });
  const waiting = useMutation({ mutationFn: () => post(`/console/tickets/${ticket.number}/status`, { status: "WAITING_ON_USER" }) });
  const { data: people = [] } = useQuery(assigneesQuery(ticket.number));
  const resolve = useMutation({
    mutationFn: () => post(`/console/tickets/${ticket.number}/resolve`, { note }),
    onSuccess: () => {
      setResolving(false);
      setNote("");
    },
  });
  const done = ticket.status === "RESOLVED" || ticket.status === "CLOSED";
  if (done) return null;
  const error = assign.error ?? start.error ?? waiting.error ?? resolve.error;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {ticket.assignee?.id !== meId && (
          <Button variant="outline" onClick={() => assign.mutate(undefined)} disabled={assign.isPending}>
            <UserPlus /> Assign to me
          </Button>
        )}
        {people.length > 1 && (
          <label className="inline-flex">
            <span className="sr-only">Assign to</span>
            <select
              value={ticket.assignee?.id ?? ""}
              disabled={assign.isPending}
              onChange={(e) => e.target.value && assign.mutate(e.target.value)}
              className="min-h-11 rounded-full border border-control bg-card px-3.5 text-sm font-semibold text-ink focus:border-brand-700 focus:outline-none"
            >
              <option value="">{ticket.assignee ? "Reassign…" : "Assign to…"}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.role === "admin" ? " (admin)" : ""} · {p.open} open
                </option>
              ))}
            </select>
          </label>
        )}
        {ticket.status !== "IN_PROGRESS" && (
          <Button variant="outline" onClick={() => start.mutate()} disabled={start.isPending}>
            <Play /> Start work
          </Button>
        )}
        {ticket.status !== "WAITING_ON_USER" && (
          <Button variant="outline" onClick={() => waiting.mutate()} disabled={waiting.isPending}>
            <Hourglass /> Waiting on user
          </Button>
        )}
        {!resolving && (
          <Button onClick={() => setResolving(true)}>
            <CheckCircle2 /> Resolve
          </Button>
        )}
      </div>
      {resolving && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3) resolve.mutate();
          }}
          className="space-y-2"
        >
          <label htmlFor="resolution" className="text-sm font-bold">
            What fixed it? (sent to the employee)
          </label>
          <textarea
            id="resolution"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-h-20 w-full rounded-2xl border border-control bg-card px-4 py-3 text-[15px] focus:border-brand-700 focus:outline-none"
            placeholder="e.g. Replaced the access point on floor 3; reconnect to Minocy-Corp."
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={note.trim().length < 3 || resolve.isPending}>
              Resolve &amp; ask the employee
            </Button>
            <Button variant="ghost" onClick={() => setResolving(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <p className="text-sm text-critical">That didn&apos;t work. Refresh and try again.</p>}
    </Card>
  );
}

/** Requester: "Did this fix it?" on a resolved ticket (same as the email's Yes/No links). */
export function ConfirmCard({ ticket }: { ticket: Ticket }) {
  const post = useTicketMutation(ticket.number);
  const [no, setNo] = useState(false);
  const [reason, setReason] = useState("");
  const confirm = useMutation({ mutationFn: (answer: "yes" | "no") => post(`/tickets/${ticket.number}/confirm`, { answer, reason: answer === "no" ? reason : undefined }) });
  if (ticket.status !== "RESOLVED") return null;

  return (
    <Card className="border-brand-700/30 bg-brand-50">
      <p className="font-bold text-brand-800">The IT team marked this as resolved. Did it fix the problem?</p>
      {no ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate("no");
          }}
          className="mt-3 space-y-2"
        >
          <label htmlFor="still" className="text-sm font-semibold">
            What&apos;s still wrong?
          </label>
          <textarea
            id="still"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-h-20 w-full rounded-2xl border border-control bg-card px-4 py-3 text-[15px] focus:border-brand-700 focus:outline-none"
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={confirm.isPending}>
              Reopen ticket
            </Button>
            <Button variant="ghost" onClick={() => setNo(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => confirm.mutate("yes")} disabled={confirm.isPending}>
            <ThumbsUp /> Yes, it&apos;s fixed
          </Button>
          <Button variant="outline" onClick={() => setNo(true)} disabled={confirm.isPending}>
            <ThumbsDown /> No, still broken
          </Button>
        </div>
      )}
    </Card>
  );
}
