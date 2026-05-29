"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rolloverTodo } from "@/lib/server-actions/todos";

export function TodoRolloverButton({
  todoId,
  readOnly,
}: {
  todoId: string;
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) return null;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await rolloverTodo({ todoId });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        title="carry this to-do forward to the next L10"
        className="focus-ring rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-foreground/40 hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
      >
        {pending ? "…" : "carry fwd"}
      </button>
      {error && <span className="font-mono text-[10px] text-status-red">{error}</span>}
    </span>
  );
}
