"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { JerryActionIntent, JerryResponse } from "@/lib/jerry/types";

interface ChatTurn {
  who: "you" | "jerry";
  text: string;
  intents?: JerryActionIntent[];
  /** error string if the turn failed */
  error?: string;
}

const INTENT_LABEL: Record<JerryActionIntent["kind"], string> = {
  update_actual: "update KPI value",
  update_rock_status: "update rock status",
  set_todo_done: "mark to-do done",
  update_issue_status: "update issue status",
  create_todo: "create to-do",
  create_issue: "create issue",
};

/** Floating Ask-Jerry dock. Bottom-right button toggles a right-side
 *  panel with a chat thread + per-suggestion Approve/Skip buttons. */
export function JerryDock() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, open]);

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");
    setTurns((t) => [...t, { who: "you", text: prompt }]);
    startTransition(async () => {
      try {
        const res = await fetch("/api/jerry/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const json = (await res.json()) as
          | (JerryResponse & { error?: never })
          | { error: string; code?: string };
        if (!res.ok || "error" in json) {
          const msg =
            "code" in json && json.code === "not_configured"
              ? "Jerry is not configured. Set JERRY_BASE_URL and JERRY_API_KEY."
              : (json as { error: string }).error;
          setTurns((t) => [...t, { who: "jerry", text: "", error: msg }]);
          return;
        }
        setTurns((t) => [
          ...t,
          {
            who: "jerry",
            text: (json as JerryResponse).reply,
            intents: (json as JerryResponse).actionIntents,
          },
        ]);
      } catch (err) {
        setTurns((t) => [
          ...t,
          {
            who: "jerry",
            text: "",
            error: err instanceof Error ? err.message : String(err),
          },
        ]);
      }
    });
  }

  async function approve(intent: JerryActionIntent, turnIdx: number, intentIdx: number) {
    const res = await fetch("/api/jerry/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    const json = (await res.json()) as { ok?: true; error?: string };
    if (!res.ok || json.error) {
      setTurns((t) =>
        t.map((turn, i) => {
          if (i !== turnIdx) return turn;
          return { ...turn, error: json.error ?? "apply failed" };
        }),
      );
      return;
    }
    // Mark applied by removing the intent so it disappears from the dock.
    setTurns((t) =>
      t.map((turn, i) => {
        if (i !== turnIdx) return turn;
        const intents = (turn.intents ?? []).filter((_, j) => j !== intentIdx);
        return { ...turn, intents: intents.length > 0 ? intents : undefined };
      }),
    );
    router.refresh();
  }

  function skip(turnIdx: number, intentIdx: number) {
    setTurns((t) =>
      t.map((turn, i) => {
        if (i !== turnIdx) return turn;
        const intents = (turn.intents ?? []).filter((_, j) => j !== intentIdx);
        return { ...turn, intents: intents.length > 0 ? intents : undefined };
      }),
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "meeting-hide fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded border border-border bg-card px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] shadow-lg transition hover:border-foreground/40",
          open && "border-amber-500/50 text-amber-100",
        )}
        title="Ask Jerry — meeting copilot"
      >
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 rounded-full", open ? "bg-amber-400" : "bg-emerald-400")}
        />
        ask jerry
      </button>

      {open && (
        <aside
          role="complementary"
          aria-label="Jerry copilot"
          className="fixed bottom-16 right-5 z-40 flex h-[70vh] w-[26rem] max-w-[92vw] flex-col rounded border border-border bg-card shadow-2xl"
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <h3 className="text-sm font-semibold tracking-tight">Jerry</h3>
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                meeting copilot
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-muted"
            >
              esc
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {turns.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Ask Jerry about the active org&apos;s scorecard, rocks, to-do&apos;s,
                issues, or the latest transcript. He can suggest board updates
                — you approve before they apply.
              </p>
            ) : null}
            {turns.map((turn, i) => (
              <div
                key={i}
                className={cn(
                  "rounded border px-2.5 py-2 text-sm",
                  turn.who === "you"
                    ? "ml-6 border-border bg-muted/40 text-foreground"
                    : "mr-6 border-emerald-500/20 bg-emerald-500/5",
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                    {turn.who === "you" ? "you" : "jerry"}
                  </span>
                </div>
                {turn.error ? (
                  <p className="font-mono text-xs text-rose-300">{turn.error}</p>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{turn.text}</p>
                )}
                {turn.intents && turn.intents.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {turn.intents.map((intent, j) => (
                      <li
                        key={j}
                        className="flex items-start justify-between gap-2 rounded border border-border bg-card/60 px-2 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200">
                            {INTENT_LABEL[intent.kind]}
                          </span>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                            {intentSummary(intent)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => skip(i, j)}
                            className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-muted"
                          >
                            skip
                          </button>
                          <button
                            type="button"
                            onClick={() => approve(intent, i, j)}
                            className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-100 transition hover:bg-emerald-500/25"
                          >
                            approve
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {pending && (
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                jerry thinking…
              </p>
            )}
          </div>

          <form onSubmit={send} className="border-t border-border p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    (e.currentTarget.form as HTMLFormElement).requestSubmit();
                  }
                }}
                placeholder="ask jerry — ⏎ to send, ⇧⏎ for newline"
                rows={2}
                className="flex-1 resize-none rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-ring focus:outline-none"
                disabled={pending}
              />
              <button
                type="submit"
                disabled={pending || !input.trim()}
                className="rounded bg-primary px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary-foreground disabled:opacity-50"
              >
                {pending ? "…" : "ask"}
              </button>
            </div>
          </form>
        </aside>
      )}
    </>
  );
}

function intentSummary(intent: JerryActionIntent): string {
  switch (intent.kind) {
    case "update_actual":
      return `measurable ${short(intent.measurableId)} ⇒ ${intent.actual ?? "—"}`;
    case "update_rock_status":
      return `rock ${short(intent.rockId)} ⇒ ${intent.status}`;
    case "set_todo_done":
      return `todo ${short(intent.todoId)} ⇒ ${intent.done ? "done" : "open"}`;
    case "update_issue_status":
      return `issue ${short(intent.issueId)} ⇒ ${intent.action}`;
    case "create_todo":
      return `+ todo "${intent.description.slice(0, 40)}" → owner ${short(intent.ownerId)}`;
    case "create_issue":
      return `+ issue "${intent.title.slice(0, 40)}" → owner ${short(intent.ownerId)}`;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
