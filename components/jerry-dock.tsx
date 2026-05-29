"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { SegmentedControl, BrainBadge } from "@/components/ui/primitives";
import type {
  JerryActionIntent,
  JerryCitation,
  JerryResponse,
} from "@/lib/jerry/types";
import type { BrainHit } from "@/lib/brain/types";

type DockMode = "jerry" | "brain";

interface ChatTurn {
  who: "you" | "jerry";
  text: string;
  /** Which engine produced this turn. Defaults to "jerry". */
  source?: DockMode;
  intents?: JerryActionIntent[];
  citations?: JerryCitation[];
  /** Brain hits (brain turns only) — carries source_id + raw snippet for the
   *  "send to jerry" preamble. */
  hits?: BrainHit[];
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

const MODE_OPTIONS: { value: DockMode; label: string }[] = [
  { value: "jerry", label: "jerry" },
  { value: "brain", label: "brain" },
];

/** Floating Ask-Jerry dock. Bottom-right button toggles a right-side
 *  panel with a chat thread + per-suggestion Approve/Skip buttons.
 *
 *  Two modes via a segmented control in the header:
 *    · jerry  — the existing meeting copilot (/api/jerry/ask + Approve/Skip)
 *    · brain  — company-brain search (/api/brain/search), citations only.
 *  ⌘K / Ctrl-K toggles the dock open. */
export function JerryDock() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DockMode>("jerry");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, open]);

  // ⌘K / Ctrl-K to toggle; Esc to close when focus is outside the composer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag !== "TEXTAREA" && tag !== "INPUT") setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the composer when the dock opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput("");
    setTurns((t) => [...t, { who: "you", text: prompt, source: mode }]);

    if (mode === "brain") {
      startTransition(async () => {
        try {
          const res = await fetch("/api/brain/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: prompt }),
          });
          const json = (await res.json()) as
            | { hits: BrainHit[]; citations: JerryCitation[]; sources: string[] }
            | { error: string; code?: string };
          if (!res.ok || "error" in json) {
            const msg =
              "code" in json && json.code === "not_configured"
                ? "Company brain is not configured. Set COMPANY_BRAIN_API_URL and COMPANY_BRAIN_API_TOKEN."
                : (json as { error: string }).error;
            setTurns((t) => [
              ...t,
              { who: "jerry", source: "brain", text: "", error: msg },
            ]);
            return;
          }
          const ok = json as {
            hits: BrainHit[];
            citations: JerryCitation[];
            sources: string[];
          };
          setTurns((t) => [
            ...t,
            {
              who: "jerry",
              source: "brain",
              text: ok.hits.length === 0 ? "No matches in the company brain." : "",
              citations: ok.citations,
              hits: ok.hits,
            },
          ]);
        } catch (err) {
          setTurns((t) => [
            ...t,
            {
              who: "jerry",
              source: "brain",
              text: "",
              error: err instanceof Error ? err.message : String(err),
            },
          ]);
        }
      });
      return;
    }

    // ── Jerry mode (UNCHANGED ask/apply path) ────────────────────────────
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
          setTurns((t) => [...t, { who: "jerry", source: "jerry", text: "", error: msg }]);
          return;
        }
        setTurns((t) => [
          ...t,
          {
            who: "jerry",
            source: "jerry",
            text: (json as JerryResponse).reply,
            intents: (json as JerryResponse).actionIntents,
            citations: (json as JerryResponse).citations,
          },
        ]);
      } catch (err) {
        setTurns((t) => [
          ...t,
          {
            who: "jerry",
            source: "jerry",
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

  /** Copy a brain turn's hits into the composer as a context preamble and
   *  switch to Jerry mode. Client-only — no server change to the Jerry path. */
  function sendToJerry(turn: ChatTurn) {
    const hits = turn.hits ?? [];
    if (hits.length === 0) return;
    const preamble = hits
      .map((h) => `- ${h.title || h.slug} (${h.source_id}): ${h.chunk_text}`)
      .join("\n");
    setInput((cur) => {
      const ctx = `Context from the company brain:\n${preamble}\n\n`;
      return cur ? `${ctx}${cur}` : ctx;
    });
    setMode("jerry");
    inputRef.current?.focus();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "meeting-hide focus-ring fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded border border-border bg-surface-1/90 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.18em] shadow-lg backdrop-blur transition hover:border-border-strong",
          open && "border-border-strong text-foreground",
        )}
        title="Ask Jerry — meeting copilot (⌘K)"
      >
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            open
              ? "bg-status-green animate-[pulse-status_2s_ease-in-out_infinite]"
              : "bg-status-green",
          )}
        />
        ask jerry
        <kbd className="rounded border border-border bg-surface-3 px-1 text-[10px] font-normal text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      {open && (
        <aside
          role="complementary"
          aria-label="Jerry copilot"
          className="meeting-hide fixed bottom-16 right-5 z-40 flex h-[72vh] w-[27rem] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-2/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-status-green animate-[pulse-status_2s_ease-in-out_infinite]"
              />
              <h3 className="text-sm font-semibold tracking-tight">Jerry</h3>
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                copilot
              </span>
            </div>
            <div className="flex items-center gap-2">
              <SegmentedControl<DockMode>
                options={MODE_OPTIONS}
                value={mode}
                onChange={setMode}
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="focus-ring rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-surface-3"
              >
                esc
              </button>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {turns.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {mode === "brain" ? (
                  <>
                    Search the company brain — Acumatica, Pipedrive, and M365
                    (mail / calendar / SharePoint / Teams). Results come back as
                    cited snippets you can pull into Jerry.
                  </>
                ) : (
                  <>
                    Ask Jerry about the active org&apos;s scorecard, rocks,
                    to-do&apos;s, issues, or the latest transcript. He can suggest
                    board updates — you approve before they apply.
                  </>
                )}
              </p>
            ) : null}
            {turns.map((turn, i) => {
              const isBrain = turn.source === "brain";
              return (
                <div
                  key={i}
                  className={cn(
                    "rounded border px-2.5 py-2 text-sm",
                    turn.who === "you"
                      ? "ml-6 border-border bg-surface-2 text-foreground"
                      : isBrain
                        ? "mr-6 border-[hsl(var(--brain)/0.25)] bg-[hsl(var(--brain)/0.06)]"
                        : "mr-6 border-status-green/20 bg-status-green/[0.05]",
                  )}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                      {turn.who === "you" ? "you" : isBrain ? "brain" : "jerry"}
                    </span>
                    {turn.who === "jerry" && isBrain && <BrainBadge />}
                  </div>
                  {turn.error ? (
                    <p className="font-mono text-xs text-status-red">{turn.error}</p>
                  ) : turn.text ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.text}</p>
                  ) : null}

                  {/* Citations — brain uses --brain accent + source_id label;
                      Jerry vault citations keep the emerald ↳. */}
                  {turn.citations && turn.citations.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-border/60 pt-1.5">
                      {turn.citations.map((c, j) => {
                        const hit = turn.hits?.[j];
                        return (
                          <li
                            key={j}
                            className="font-mono text-[10px] leading-relaxed text-muted-foreground"
                          >
                            {isBrain ? (
                              <span className="text-[hsl(var(--brain))]">▸</span>
                            ) : (
                              <span className="text-status-green/80">↳</span>
                            )}{" "}
                            {c.href ? (
                              <a
                                href={c.href}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-foreground hover:underline"
                              >
                                {c.source}
                              </a>
                            ) : (
                              <span className="text-foreground/80">{c.source}</span>
                            )}
                            {hit?.source_id && (
                              <span className="ml-1.5 rounded bg-surface-3 px-1 text-[9px] text-muted-foreground/80">
                                {hit.source_id}
                              </span>
                            )}
                            {c.snippet && (
                              <span className="ml-2 italic text-muted-foreground/70">
                                {c.snippet.slice(0, 90)}
                                {c.snippet.length > 90 ? "…" : ""}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* Send-to-Jerry affordance on brain turns with hits. */}
                  {isBrain && turn.hits && turn.hits.length > 0 && (
                    <div className="mt-2 flex justify-end border-t border-border/60 pt-1.5">
                      <button
                        type="button"
                        onClick={() => sendToJerry(turn)}
                        className="focus-ring rounded border border-[hsl(var(--brain)/0.4)] bg-[hsl(var(--brain)/0.1)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[hsl(var(--brain))] transition hover:bg-[hsl(var(--brain)/0.18)]"
                      >
                        send to jerry
                      </button>
                    </div>
                  )}

                  {turn.intents && turn.intents.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {turn.intents.map((intent, j) => (
                        <li
                          key={j}
                          className="flex items-start justify-between gap-2 rounded border border-border bg-surface-2/60 px-2 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-status-yellow">
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
                              className="focus-ring rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-surface-3"
                            >
                              skip
                            </button>
                            <button
                              type="button"
                              onClick={() => approve(intent, i, j)}
                              className="focus-ring rounded border border-status-green/40 bg-status-green/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-status-green transition hover:bg-status-green/25"
                            >
                              approve
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            {pending && (
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {mode === "brain" ? "searching brain…" : "jerry thinking…"}
              </p>
            )}
          </div>

          <form onSubmit={send} className="border-t border-border bg-surface-2/40 p-2">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    (e.currentTarget.form as HTMLFormElement).requestSubmit();
                  }
                }}
                placeholder={
                  mode === "brain"
                    ? "search the company brain — ⏎ to search"
                    : "ask jerry — ⏎ to send, ⇧⏎ for newline"
                }
                rows={2}
                className="flex-1 resize-none rounded border border-border bg-surface-3 px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                disabled={pending}
              />
              <button
                type="submit"
                disabled={pending || !input.trim()}
                className="focus-ring rounded bg-primary px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary-foreground transition disabled:opacity-50"
              >
                {pending ? "…" : mode === "brain" ? "search" : "ask"}
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
