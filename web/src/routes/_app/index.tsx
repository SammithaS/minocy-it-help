import { createFileRoute, Link } from "@tanstack/react-router";
import { AppWindow, ArrowRight, KeyRound, Mail, Printer, Ticket, Wifi } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

const tiles = [
  { title: "Reset password", note: "Locked out or expired", icon: KeyRound, bg: "#FFE3B3", fg: "#7A4A00" },
  { title: "Wi-Fi & VPN", note: "Dropping, slow, can't connect", icon: Wifi, bg: "#E3F2F1", fg: "#08555B" },
  { title: "Email & calendar", note: "Outlook, sync, shared mailboxes", icon: Mail, bg: "#E6ECFF", fg: "#2B4AC2" },
  { title: "Printers", note: "Jams, drivers, scan to email", icon: Printer, bg: "#FDE4EC", fg: "#A3214E" },
  { title: "Software", note: "Install or fix an app", icon: AppWindow, bg: "#EDE7FB", fg: "#5B3DB5" },
  { title: "Raise a ticket", note: "Talk to the IT team", icon: Ticket, bg: "#17262A", fg: "#FFFFFF" },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Home() {
  const { me } = Route.useRouteContext();
  const first = me.user.name.split(" ")[0];

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-hero bg-hero px-6 py-10 text-white sm:px-10 sm:py-14">
        <div aria-hidden className="absolute -top-16 -right-10 size-56 rounded-full bg-sun opacity-90" />
        <div aria-hidden className="absolute -right-24 -bottom-28 size-72 rounded-full bg-brand-600 opacity-70" />
        <div className="relative max-w-2xl">
          <p className="text-[15px] text-[#CDEDEA]">
            {greeting()}, {first} 👋
          </p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-[38px] sm:leading-tight">
            What&apos;s not working today?
          </h1>
          <form
            className="mt-6 flex items-center gap-2 rounded-[18px] bg-white p-2 shadow-chat"
            onSubmit={(e) => e.preventDefault()}
          >
            <label htmlFor="ask" className="sr-only">
              Describe your problem
            </label>
            <input
              id="ask"
              disabled
              placeholder="The assistant arrives in Phase 3…"
              className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-[15px] text-[#17262A] placeholder:text-[#55666B] focus:outline-none"
            />
            <button
              type="submit"
              disabled
              className="min-h-11 rounded-full bg-[#17262A] px-5 text-sm font-bold text-white disabled:opacity-60"
            >
              Ask
            </button>
          </form>
          <div className="mt-4 flex flex-wrap gap-2">
            {["Wi-Fi keeps dropping", "VPN timeout", "Laptop is slow"].map((chip) => (
              <span key={chip} className="rounded-full bg-white/15 px-3.5 py-2 text-[13px] font-semibold text-white">
                {chip}
              </span>
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
            <CardDescription>Nothing open right now.</CardDescription>
          </div>
          <Link to="/tickets" className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">
            View all <ArrowRight className="size-4" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
