import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireStaff } from "@/lib/guards";

export const Route = createFileRoute("/_app/console")({
  beforeLoad: async ({ context, location }) => {
    await requireStaff(context, location.href);
  },
  component: () => <Outlet />,
});
