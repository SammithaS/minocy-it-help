import { queryOptions } from "@tanstack/react-query";

export type Role = "employee" | "agent" | "admin";

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    department: string | null;
    location: string | null;
  };
  devices: { id: string; assetTag: string; model: string; os: string }[];
  teams: { id: string; name: string }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}

/** Current user, or null when signed out. */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await apiFetch<Me>("/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  staleTime: 60_000,
});

export const isStaff = (role: Role | undefined) => role === "agent" || role === "admin";
