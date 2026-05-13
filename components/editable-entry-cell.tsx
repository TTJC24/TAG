"use client";

import { useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { updateActual } from "@/lib/server-actions/measurables";
import { StatusCell } from "@/components/status-cell";
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
        className="group inline-flex flex-col items-stretch gap-1 rounded outline-offset-2 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        title={currentNote ?? result?.reason}
      >
        <StatusCell display={display} result={result} />
        {currentNote && (
          <span
            aria-hidden
            className="pointer-events-none mx-auto h-1 w-1 rounded-full bg-muted-foreground/70"
          />
        )}
      </button>
    );
  }

  return (
    <div className="space-y-1 rounded border border-ring bg-background p-2">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={pending}
        placeholder="actual"
        className="w-full rounded border border-border bg-background px-2 py-1 text-right font-mono text-sm tabular focus:border-ring focus:outline-none"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={pending}
        placeholder="note (optional)"
        className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs focus:border-ring focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        {error && (
          <span className="mr-auto font-mono text-[10px] text-red-500">
            {error}
          </span>
        )}
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-muted"
        >
          esc
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={pending}
          className="rounded bg-primary px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary-foreground disabled:opacity-50"
        >
          {pending ? "…" : "save"}
        </button>
      </div>
    </div>
  );
}
