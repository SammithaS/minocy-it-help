import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DockProvider } from "@/components/chat/dock";
import { TopNav } from "@/components/top-nav";
import { isStaff } from "@/lib/api";
import { requireUser } from "@/lib/guards";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => ({
    me: await requireUser(context, location.href),
  }),
  component: AppLayout,
});

function AppLayout() {
  const { me } = Route.useRouteContext();
  return (
    <DockProvider key={me.user.id} userId={me.user.id} staff={isStaff(me.user.role)}>
      <div className="min-h-dvh pb-20 md:pb-0">
        <TopNav me={me} />
        <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
          <Outlet />
        </main>
      </div>
    </DockProvider>
  );
}
