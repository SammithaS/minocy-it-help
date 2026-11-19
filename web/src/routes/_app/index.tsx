import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AppWindow, ArrowRight, KeyRound, Mail, Printer, Ticket, Wifi } from "lucide-react";
import { TicketRow } from "@/components/tickets/ticket-row";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { isOpen, myTicketsQuery } from "@/lib/tickets";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

const tiles = [
  { title: "Reset password", note: "Locked out or expired", icon: KeyRound, bg: "#E8EFFD", fg: "#1D4ED8" },
  { title: "Wi-Fi & VPN", note: "Dropping, slow, can't connect", icon: Wifi, bg: "#E0F2FE", fg: "#0369A1" },
  { title: "Email & calendar", note: "Outlook, sync, shared mailboxes", icon: Mail, bg: "#EEF2FF", fg: "#4338CA" },
  { title: "Printers", note: "Jams, drivers, scan to email", icon: Printer, bg: "#F1F5F9", fg: "#334155" },
  { title: "Software", note: "Install or fix an app", icon: AppWindow, bg: "#ECFEFF", fg: "#0E7490" },
  { title: "Raise a ticket", note: "Talk to the IT team", icon: Ticket, bg: "#0F1B2D", fg: "#FFFFFF" },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Home() {
  const { me } = Route.useRouteContext();
  const first = me.user.name.split(" ")[0];
  const navigate = useNavigate();
  const { data: tickets = [] } = useQuery(myTicketsQuery);
  const open = tickets.filter((t) => isOpen(t.status));
  const [ask, setAsk] = useState("");
  const startChat = (q: string) => {
    if (q.trim()) void navigate({ to: "/chat", search: { q: q.trim() } });
  };
  const onAsk = (e: FormEvent) => {
    e.preventDefault();
    startChat(ask);
  };

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-hero bg-hero px-6 py-10 text-white sm:px-10 sm:py-14">
        <div aria-hidden className="absolute -top-20 -right-14 size-64 rounded-full bg-brand-600" />
        <div aria-hidden className="absolute right-28 -bottom-32 size-56 rounded-full bg-sun opacity-55" />
        <div className="relative max-w-2xl">
          <p className="text-[15px] text-hero-soft">
            {greeting()}, {first} 👋
          </p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-[38px] sm:leading-tight">
            What&apos;s not working today?
          </h1>
          <form
            className="mt-6 flex items-center gap-2 rounded-[14px] bg-white p-2 shadow-chat"
            onSubmit={onAsk}
          >
            <label htmlFor="ask" className="sr-only">
              Describe your problem
            </label>
            <input
              id="ask"
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder="e.g. My Wi-Fi keeps dropping"
              className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-[15px] text-[#0F1B2D] placeholder:text-[#52607A] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!ask.trim()}
              className="min-h-11 rounded-full bg-ink-surface px-5 text-sm font-bold text-white disabled:opacity-60"
            >
              Ask
            </button>
          </form>
          <div className="mt-4 flex flex-wrap gap-2">
            {["Wi-Fi keeps dropping", "VPN timeout", "Laptop is slow"].map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => startChat(chip)}
                className="min-h-9 rounded-full bg-white/15 px-3.5 text-[13px] font-semibold text-white hover:bg-white/25"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xl font-extrabold">Fix it yourself</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((t) => (
            <div key={t.title} className="rounded-tile border border-line bg-card p-4">
              <span
                className="grid size-11 place-items-center rounded-xl"
                style={{ background: t.bg, color: t.fg }}
              >
                <t.icon className="size-5" strokeWidth={2} />
              </span>
              <p className="mt-3 text-[15px] font-bold">{t.title}</p>
              <p className="mt-0.5 text-[13px] text-muted">{t.note}</p>
            </div>
          ))}
        </div>
      </section>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Your tickets</CardTitle>
            <CardDescription>{open.length ? `${open.length} open` : "Nothing open right now."}</CardDescription>
          </div>
          <Link to="/tickets" className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-brand-700">
            View all <ArrowRight className="size-4" />
          </Link>
        </div>
        {open.length > 0 && (
          <div className="mt-4 space-y-2.5">
            {open.slice(0, 3).map((t) => (
              <TicketRow key={t.id} ticket={t} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
