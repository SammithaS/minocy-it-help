import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Headset,
  Home,
  LayoutDashboard,
  LogOut,
  Mail,
  Moon,
  Settings,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { isStaff, type Me } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { toggleTheme } from "@/lib/theme";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export function navItemsFor(me: Me): NavItem[] {
  const employee: NavItem[] = [
    { to: "/", label: "Home", icon: Home },
    { to: "/tickets", label: "My tickets", icon: Ticket },
    { to: "/articles", label: "Guides", icon: BookOpen },
  ];
  if (!isStaff(me.user.role)) return employee;
  const staff: NavItem[] = [
    { to: "/console", label: "Console", icon: LayoutDashboard },
    { to: "/", label: "Portal", icon: Headset },
  ];
  if (me.user.role === "admin") {
    staff.push({ to: "/console/outbox", label: "Outbox", icon: Mail });
    staff.push({ to: "/console/settings", label: "Settings", icon: Settings });
  }
  return staff;
}

const pillBase =
  "flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-muted transition-colors hover:text-ink";
const pillActive = "bg-brand-50 text-brand-800 hover:text-brand-800";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function TopNav({ me }: { me: Me }) {
  const items = navItemsFor(me);
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await authClient.signOut();
    qc.setQueryData(["me"], null);
    await navigate({ to: "/login" });
  }

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2.5 font-extrabold text-ink">
            <span className="grid size-9 place-items-center rounded-full bg-brand-700 text-on-brand">
              <Headset className="size-5" strokeWidth={2} />
            </span>
            <span className="text-[15px]">Minocy IT Help</span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={pillBase}
                activeProps={{ className: pillActive }}
                activeOptions={{ exact: item.to === "/" || item.to === "/console" }}
              >
                <item.icon className="size-4" strokeWidth={2} />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleTheme}
              className="grid size-11 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink"
              aria-label="Toggle dark mode"
            >
              <Moon className="size-5" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={signOut}
              className="grid size-11 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink"
              aria-label="Sign out"
            >
              <LogOut className="size-5" strokeWidth={2} />
            </button>
            <span
              className="ml-1 grid size-10 place-items-center rounded-full bg-sun text-sm font-bold text-[#17262A]"
              title={`${me.user.name} · ${me.user.role}`}
            >
              {initials(me.user.name)}
            </span>
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main"
      >
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-muted"
            activeProps={{ className: "text-brand-700" }}
            activeOptions={{ exact: item.to === "/" || item.to === "/console" }}
          >
            <item.icon className="size-5" strokeWidth={2} />
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
