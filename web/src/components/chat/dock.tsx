import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Maximize2, Minus, Plus, Sparkles } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChatPanel } from "./chat-panel";

/**
 * The docked "Ask IT" chat: a launcher on every portal page and a panel that keeps the current
 * conversation while you move around (full-screen sheet on phones). The hero, chips and tiles open it
 * with a message, which starts a fresh conversation with the supervisor.
 */
interface DockApi {
  /** Opens the dock; with a message, starts a new conversation and sends it. */
  open: (message?: string) => void;
  close: () => void;
}

const DockContext = createContext<DockApi | null>(null);
export const useDock = () => {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock outside DockProvider");
  return ctx;
};

const KEY = "askit.dock";
interface Persisted {
  sessionId: string | null;
  open: boolean;
}
function load(): Persisted {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Persisted | null;
    return v && typeof v === "object" ? { sessionId: v.sessionId ?? null, open: !!v.open } : { sessionId: null, open: false };
  } catch {
    return { sessionId: null, open: false };
  }
}
function save(v: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Private mode / blocked storage: the dock still works, it just won't survive a reload.
  }
}

/** Pages where the dock would duplicate or get in the way (the full-page chat, the IT console). */
const HIDDEN_ON = [/^\/chat(\/|$)/, /^\/console(\/|$)/];

export function DockProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(load);
  const [pending, setPending] = useState<string | undefined>();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const hidden = HIDDEN_ON.some((re) => re.test(pathname));

  useEffect(() => save(state), [state]);

  const open = useCallback((message?: string) => {
    const text = message?.trim();
    if (text) {
      setPending(text);
      setState({ sessionId: crypto.randomUUID(), open: true });
    } else {
      setState((s) => ({ sessionId: s.sessionId ?? crypto.randomUUID(), open: true }));
    }
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const newChat = () => {
    setPending(undefined);
    setState({ sessionId: crypto.randomUUID(), open: true });
  };
  const expand = () => {
    if (!state.sessionId) return;
    const id = state.sessionId;
    setState((s) => ({ ...s, open: false }));
    void navigate({ to: "/chat/$sessionId", params: { sessionId: id }, search: {} });
  };
  const clearPending = useCallback(() => setPending(undefined), []);

  // Esc minimises the dock.
  useEffect(() => {
    if (!state.open || hidden) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, hidden, close]);

  const api = useMemo(() => ({ open, close }), [open, close]);
  const showPanel = state.open && !hidden && state.sessionId;

  const iconBtn = "grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white";

  return (
    <DockContext.Provider value={api}>
      {children}
      {showPanel && (
        <div
          role="dialog"
          aria-label="Ask IT"
          className={cn(
            "fixed z-40 flex flex-col",
            // Phone: full-screen sheet above everything (incl. the tab bar).
            "inset-0 bg-canvas pt-[env(safe-area-inset-top)]",
            // Desktop: a panel docked bottom-right.
            "md:inset-auto md:right-6 md:bottom-6 md:h-[min(680px,calc(100dvh-7rem))] md:w-[400px] md:bg-transparent md:pt-0",
          )}
        >
          <ChatPanel
            key={state.sessionId}
            sessionId={state.sessionId!}
            initialMessage={pending}
            onInitialMessageSent={clearPending}
            className="min-h-0 flex-1 rounded-none md:rounded-[24px]"
            headerActions={
              <>
                <button type="button" onClick={newChat} className={iconBtn} aria-label="New chat" title="New chat">
                  <Plus className="size-4.5" />
                </button>
                <button type="button" onClick={expand} className={iconBtn} aria-label="Open full page" title="Open full page">
                  <Maximize2 className="size-4" />
                </button>
                <button type="button" onClick={close} className={iconBtn} aria-label="Minimise chat" title="Minimise (Esc)">
                  <Minus className="size-4.5" />
                </button>
              </>
            }
          />
        </div>
      )}
      {!hidden && !state.open && (
        <button
          type="button"
          onClick={() => open()}
          className="fixed right-4 bottom-20 z-30 flex min-h-12 items-center gap-2 rounded-full bg-ink-surface py-2 pr-5 pl-2 text-sm font-bold text-white shadow-chat transition-transform hover:-translate-y-0.5 md:right-6 md:bottom-6"
        >
          <span className="grid size-8 place-items-center rounded-full bg-sun text-[#0F1B2D]">
            <Sparkles className="size-4.5" strokeWidth={2.25} />
          </span>
          {state.sessionId ? "Continue chat" : "Ask IT"}
        </button>
      )}
    </DockContext.Provider>
  );
}
