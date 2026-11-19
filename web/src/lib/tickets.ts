import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Priority, TicketStatus } from "@/components/ui/badge";
import { apiFetch } from "./api";

export interface Ticket {
  id: string;
  number: string;
  title: string;
  description: string;
  category: string;
  priority: Priority;
  status: TicketStatus;
  source: "CHAT" | "PORTAL" | "EMAIL";
  team: { id: string; name: string | null } | null;
  requester: { id: string; name: string | null };
  assignee: { id: string; name: string | null } | null;
  sessionId: string | null;
  kbArticleId: string | null;
  stepsTried: { order: number; text: string; result: string }[];
  device: string | null;
  slaDueAt: number | null;
  slaBreached: boolean;
  firstResponseAt: number | null;
  resolvedAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TicketComment {
  id: string;
  body: string;
  visibility: "public" | "internal";
  source: string;
  created_at: number;
  author_name: string | null;
  author_role: string | null;
  author_id: string | null;
}

export interface TicketEvent {
  type: string;
  data: Record<string, unknown> | null;
  created_at: number;
}

export const myTicketsQuery = queryOptions({
  queryKey: ["tickets", "mine"],
  queryFn: () => apiFetch<{ tickets: Ticket[] }>("/tickets").then((r) => r.tickets),
  staleTime: 15_000,
});

export const ticketQuery = (number: string) =>
  queryOptions({
    queryKey: ["tickets", "detail", number],
    queryFn: () => apiFetch<{ ticket: Ticket; comments: TicketComment[]; events: TicketEvent[] }>(`/tickets/${number}`),
    staleTime: 10_000,
  });

export const consoleQueueQuery = (params: { scope: "mine" | "all"; status: "open" | "all"; team?: string }) =>
  queryOptions({
    queryKey: ["console", "queue", params],
    queryFn: () => {
      const q = new URLSearchParams({ scope: params.scope, status: params.status, ...(params.team ? { team: params.team } : {}) });
      return apiFetch<{ tickets: Ticket[]; teams: { id: string; name: string }[] }>(`/console/tickets?${q}`);
    },
    staleTime: 30_000,
  });

export const isOpen = (s: TicketStatus) => s !== "RESOLVED" && s !== "CLOSED";

/** "due in 3h 20m" / "overdue by 15m" — re-renders every 30 s. */
export function useSlaLabel(dueAt: number | null, done: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!dueAt || done) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [dueAt, done]);
  if (!dueAt || done) return null;
  const diff = dueAt - now;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const d = Math.floor(h / 24);
  const text = d >= 1 ? `${d}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
  return { overdue: diff < 0, soon: diff >= 0 && diff < 3_600_000, text: diff < 0 ? `overdue by ${text}` : `due in ${text}` };
}

export interface BoardMessage {
  type: "hello" | "ticket.created" | "ticket.updated";
  ticket?: { number: string; title: string; priority: Priority; teamId: string | null; team: { name: string } | null };
  number?: string;
  teamId?: string | null;
}

/** Live console feed: reconnects with backoff, refreshes queue queries, reports new tickets. */
export function useBoardFeed(onMessage: (m: BoardMessage) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/console/live`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const m = JSON.parse(String(e.data)) as BoardMessage;
        if (m.type !== "hello") {
          void qc.invalidateQueries({ queryKey: ["console"] });
          if (m.number) void qc.invalidateQueries({ queryKey: ["tickets", "detail", m.number] });
        }
        handler.current(m);
      };
      ws.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        if (stopped) return;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, [qc]);

  return connected;
}

export const CATEGORY_LABEL: Record<string, string> = {
  network: "Network",
  hardware: "Hardware",
  software: "Software",
  identity: "Identity & Access",
  collaboration: "Collaboration",
};

export const timeAgo = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
