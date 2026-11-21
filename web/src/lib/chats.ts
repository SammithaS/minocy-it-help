import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

export interface ChatSummary {
  id: string;
  title: string;
  outcome: "open" | "resolved" | "escalated" | "abandoned";
  articleId: string | null;
  createdAt: number;
  updatedAt: number;
  rating: "up" | "down" | null;
}

export interface ChatFeedback {
  rating: "up" | "down";
  comment: string | null;
}

export const myChatsQuery = queryOptions({
  queryKey: ["chats", "mine"],
  queryFn: () => apiFetch<{ chats: ChatSummary[] }>("/chats").then((r) => r.chats),
  staleTime: 15_000,
});

export const chatFeedbackQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["chats", sessionId, "feedback"],
    queryFn: () => apiFetch<{ feedback: ChatFeedback | null }>(`/chats/${sessionId}/feedback`).then((r) => r.feedback),
  });

export function useSaveFeedback(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: ChatFeedback) =>
      apiFetch<{ feedback: ChatFeedback }>(`/chats/${sessionId}/feedback`, { method: "PUT", body: JSON.stringify(f) }).then((r) => r.feedback),
    onSuccess: (f) => {
      qc.setQueryData(chatFeedbackQuery(sessionId).queryKey, f);
      void qc.invalidateQueries({ queryKey: myChatsQuery.queryKey });
    },
  });
}

/** "2h ago", "Yesterday", "12 Nov". */
export function relativeTime(ms: number, now = Date.now()): string {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  if (h < 48) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
