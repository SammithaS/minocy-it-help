import { queryOptions } from "@tanstack/react-query";
import { AppWindow, KeyRound, Mail, Monitor, ShieldAlert, Users, Wifi, type LucideIcon } from "lucide-react";
import { apiFetch } from "./api";

export interface ArticleSummary {
  id: string;
  title: string;
  category: string;
  tags: string[];
  os: string[];
  ticketCategory: string;
  action: string;
}

export interface ArticleDetail extends ArticleSummary {
  priority: string;
  intro: string[];
  symptoms: string[];
  steps: { section: "quick" | "advanced"; order: number; text: string }[];
  escalateWhen: string[];
  updatedAt: string;
}

export interface SearchHit {
  articleId: string;
  title: string;
  category: string;
  section: string;
  snippet: string;
  score: number;
  vectorScore: number | null;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  confident: boolean;
  os: string | null;
}

export const articlesQuery = queryOptions({
  queryKey: ["kb", "articles"],
  queryFn: () => apiFetch<{ articles: ArticleSummary[] }>("/kb/articles").then((r) => r.articles),
  staleTime: 5 * 60_000,
});

export const articleQuery = (id: string) =>
  queryOptions({
    queryKey: ["kb", "article", id],
    queryFn: () => apiFetch<{ article: ArticleDetail }>(`/kb/articles/${id}`).then((r) => r.article),
    staleTime: 5 * 60_000,
  });

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ["kb", "search", q],
    queryFn: () => apiFetch<SearchResponse>(`/kb/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  });

/** Icon + Option B tile colours per article category. */
export const categoryStyle: Record<string, { icon: LucideIcon; bg: string; fg: string }> = {
  Network: { icon: Wifi, bg: "#E3F2F1", fg: "#08555B" },
  Accounts: { icon: KeyRound, bg: "#FFE3B3", fg: "#7A4A00" },
  Security: { icon: ShieldAlert, bg: "#FEE2E2", fg: "#B91C1C" },
  Email: { icon: Mail, bg: "#E6ECFF", fg: "#2B4AC2" },
  Collaboration: { icon: Users, bg: "#E6ECFF", fg: "#2B4AC2" },
  Software: { icon: AppWindow, bg: "#EDE7FB", fg: "#5B3DB5" },
  Hardware: { icon: Monitor, bg: "#FDE4EC", fg: "#A3214E" },
  Performance: { icon: Monitor, bg: "#FDE4EC", fg: "#A3214E" },
  Printing: { icon: Monitor, bg: "#FDE4EC", fg: "#A3214E" },
};
export const styleFor = (category: string) => categoryStyle[category] ?? categoryStyle.Software!;

export const osLabel: Record<string, string> = { windows: "Windows", macos: "Mac", linux: "Linux" };
