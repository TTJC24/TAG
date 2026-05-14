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
        className="rounded border border-border bg-muted/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        {pending ? "…" : "carry forward"}
      </button>
      {error && <span className="font-mono text-[10px] text-rose-300">{error}</span>}
    </span>
  );
}
