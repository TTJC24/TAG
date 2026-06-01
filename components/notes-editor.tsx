"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NotesEditorProps {
  /** Stable id used by the action — opaque to this component. */
  entityId: string;
  /** Current saved value. */
  value: string | null;
  /** Server action returning ActionResult — accepts the entity id + new
   *  notes value. Wrapped here so the parent can supply rock/todo/issue. */
  onSave: (
    id: string,
    notes: string | null,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  readOnly?: boolean;
  placeholder?: string;
}

export function NotesEditor({
  entityId,
  value,
  onSave,
  readOnly,
  placeholder = "notes",
}: NotesEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Keep the draft in sync if the parent re-renders with new server data.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  if (readOnly) {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {value ?? ""}
      </span>
    );
  }

  function commit() {
    setError(null);
    startTransition(async () => {
      const trimmed = draft.trim();
      const next = trimmed.length > 0 ? trimmed : null;
      const r = await onSave(entityId, next);
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
    setDraft(value ?? "");
    setError(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
          "focus-ring block w-full rounded px-1 py-0.5 text-left font-mono text-xs transition hover:bg-surface-2",
          value ? "text-muted-foreground" : "text-muted-foreground/50 italic",
        )}
      >
        {value ?? `+ ${placeholder}`}
      </button>
    );
  }

  return (
    <div className="space-y-1 rounded border border-border-strong bg-surface-2 p-2">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={pending}
        placeholder={placeholder}
        rows={2}
        className="w-full rounded border border-border bg-surface-3 px-2 py-1 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-end gap-2">
        {error ? (
          <span className="mr-auto font-mono text-[10px] text-status-red">
            {error}
          </span>
        ) : (
          <span className="mr-auto font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
            ⌘⏎ save · esc cancel
          </span>
        )}
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="focus-ring rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-surface-3"
        >
          esc
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={pending}
          className="focus-ring rounded bg-primary px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary-foreground disabled:opacity-50"
        >
          {pending ? "…" : "save"}
        </button>
      </div>
    </div>
  );
}
