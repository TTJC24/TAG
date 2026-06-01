"use client";

import { useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { updateMeasurable } from "@/lib/server-actions/measurables";
import { formatGoal } from "@/lib/format";
import { cn } from "@/lib/utils";

type GoalDirection =
  | "gte"
  | "lte"
  | "eq"
  | "between"
  | "trend_down"
  | "trend_up";

interface EditableGoalCellProps {
  measurableId: string;
  goalDirection: GoalDirection;
  goalValue: number | null;
  goalSecondary: number | null;
  formatHint: string | null;
  /** True for viewers and non-owners. Falls back to a static label. */
  readOnly?: boolean;
}

/** Click-to-edit goal value cell. The goal column on /scorecard is the
 *  most-edited admin field; this avoids forcing a full modal for it.
 *  For "between" direction, edits the primary goal only — the secondary
 *  is rare and can be set via the full Edit dialog. */
export function EditableGoalCell({
  measurableId,
  goalDirection,
  goalValue,
  goalSecondary,
  formatHint,
  readOnly,
}: EditableGoalCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    goalValue === null ? "" : String(goalValue),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const display = formatGoal(goalDirection, goalValue, goalSecondary, formatHint);

  if (readOnly) {
    return (
      <span className="font-mono text-xs tabular text-muted-foreground">
        {display}
      </span>
    );
  }

  function commit() {
    setError(null);
    startTransition(async () => {
      const r = await updateMeasurable({
        measurableId,
        goalValue: draft.trim() || null,
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
    setDraft(goalValue === null ? "" : String(goalValue));
    setError(null);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
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
        title="click to edit goal"
        className={cn(
          "focus-ring group inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 font-mono text-xs tabular transition",
          "hover:border-border hover:bg-surface-3 hover:text-foreground",
          goalValue === null ? "text-status-red" : "text-muted-foreground",
        )}
      >
        <span>{display}</span>
        <span
          aria-hidden
          className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60 opacity-0 transition group-hover:opacity-100"
        >
          edit
        </span>
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        disabled={pending}
        inputMode="decimal"
        placeholder="goal"
        className={cn(
          "w-20 rounded border border-ring bg-surface-3 px-1.5 py-0.5 text-right font-mono text-xs tabular",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      />
      {pending && (
        <span className="font-mono text-[10px] text-muted-foreground">…</span>
      )}
      {error && (
        <span className="font-mono text-[10px] text-status-red">{error}</span>
      )}
    </span>
  );
}
