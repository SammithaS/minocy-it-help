import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { isStaff, meQuery, type Me } from "./api";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Redirects to /login when signed out; returns the current user. */
export async function requireUser(ctx: RouterContext, href: string): Promise<Me> {
  const me = await ctx.queryClient.ensureQueryData(meQuery);
  if (!me) throw redirect({ to: "/login", search: { redirect: href } });
  return me;
}

/** Requires an IT Agent or IT Admin. */
export async function requireStaff(ctx: RouterContext, href: string): Promise<Me> {
  const me = await requireUser(ctx, href);
  if (!isStaff(me.user.role)) throw redirect({ to: "/" });
  return me;
}
