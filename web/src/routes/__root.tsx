import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import type { RouterContext } from "@/lib/guards";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <div className="grid min-h-dvh place-items-center p-6 text-center">
      <div>
        <p className="text-5xl font-extrabold text-brand-700">404</p>
        <p className="mt-2 text-muted">We couldn&apos;t find that page.</p>
        <Link to="/" className="mt-4 inline-block font-bold text-brand-700 underline">
          Back home
        </Link>
      </div>
    </div>
  ),
});
