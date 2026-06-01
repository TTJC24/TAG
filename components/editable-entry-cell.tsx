"use client";

import { useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { updateActual } from "@/lib/server-actions/measurables";
import { StatusCell } from "@/components/status-cell";
import { KeyHint } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ShadingResult } from "@/lib/shading/types";

export interface EditableEntryCellProps {
  measurableId: string;
  weekId: string;
  /** Current numeric value (as stored) — pass null for "no entry yet". */
  currentActual: number | null;
  /** Current note text. */
  currentNote: string | null;
  /** What the cell displays when not in edit mode. */
  display: string;
  /** Shading result for the cell — drives the fill color. */
  result: ShadingResult | null;
  /** When true, render read-only (used for prior weeks and viewers). */
  readOnly?: boolean;
  /** Optional override for the "raw value" shown in the edit input.
   *  Defaults to the numeric value as a string. */
  rawValueForEdit?: string;
  /** Optional custom render for the resting (non-editing) display. When set,
   *  it replaces the default <StatusCell> trigger — e.g. the metric block's
   *  hero number. The edit/commit logic and server action are unchanged. */
  displayNode?: ReactNode;
}

export function EditableEntryCell({
  measurableId,
  weekId,
  currentActual,
  currentNote,
  display,
  result,
  readOnly,
  rawValueForEdit,
  displayNode,
}: EditableEntryCellProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    rawValueForEdit ?? (currentActual === null ? "" : String(currentActual)),
  );
  const [note, setNote] = useState(currentNote ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) {
    if (displayNode) return <>{displayNode}</>;
    return (
      <StatusCell
        display={display}
        result={result}
        title={currentNote ?? result?.reason}
      />
    );
  }

  function commit() {
    setError(null);
    startTransition(async () => {
      const r = await updateActual({
        measurableId,
        weekId,
        actual: value === "" ? null : value,
        note: note === "" ? null : note,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setEditing(false);
    setError(null);
    setValue(rawValueForEdit ?? (currentActual === null ? "" : String(currentActual)));
    setNote(currentNote ?? "");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "focus-ring group relative rounded transition-colors",
          displayNode
            ? "-mx-1 block w-full cursor-pointer px-1 text-left hover:bg-surface-3/50"
            : "inline-flex items-center",
        )}
        title={currentNote ?? result?.reason}
      >
        {displayNode ?? <StatusCell display={display} result={result} />}
        {currentNote && (
          <span
            aria-hidden
            title={currentNote}
            className="pointer-events-none absolute right-1 top-1 h-1 w-1 rounded-full bg-muted-foreground/70"
          />
        )}
      </button>
    );
  }

  return (
    <div className="w-44 space-y-1.5 rounded-md border border-ring bg-surface-2 p-2 shadow-lg shadow-black/40">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={pending}
        inputMode="decimal"
        placeholder="actual"
        className="w-full rounded border border-border bg-surface-3 px-2 py-1 text-right font-mono text-sm tabular focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={pending}
        placeholder="note (optional)"
        className="w-full rounded border border-border bg-surface-3 px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {error && (
        <p className="font-mono text-[10px] text-status-red">{error}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/70">
          <KeyHint>↵</KeyHint>save
          <KeyHint className="ml-1">esc</KeyHint>cancel
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={cancel}
            disabled={pending}
            className="focus-ring rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-surface-3 hover:text-foreground"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={pending}
            className="focus-ring rounded bg-primary px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary-foreground transition disabled:opacity-50"
          >
            {pending ? "…" : "save"}
          </button>
        </span>
      </div>
    </div>
  );
}
