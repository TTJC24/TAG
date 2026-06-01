"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTodoDone } from "@/lib/server-actions/todos";

interface TodoCheckboxProps {
  todoId: string;
  done: boolean;
  readOnly?: boolean;
}

export function TodoCheckbox({ todoId, done, readOnly }: TodoCheckboxProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) {
    return (
      <span
        aria-hidden
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${done ? "border-status-green/50 bg-status-green/25 text-status-green" : "border-border bg-surface-2"}`}
      >
        {done ? "✓" : ""}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await setTodoDone({ todoId, done: !done });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        disabled={pending}
        aria-pressed={done}
        className={`focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold transition disabled:opacity-50 ${
          done
            ? "border-status-green/50 bg-status-green/25 text-status-green hover:bg-status-green/35"
            : "border-border bg-surface-2 hover:border-border-strong hover:bg-surface-3"
        }`}
        title={done ? "mark not done" : "mark done"}
      >
        {pending ? "…" : done ? "✓" : ""}
      </button>
      {error && (
        <span className="font-mono text-[10px] text-status-red">{error}</span>
      )}
    </span>
  );
}
