"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateIssueStatus } from "@/lib/server-actions/issues";
import { cn } from "@/lib/utils";

type IssueAction = "worked" | "push" | "resolved";
type IssueStatus = "open" | "ids_in_progress" | "resolved";

const ACTIVE_STATUS_FOR_ACTION: Record<IssueAction, IssueStatus> = {
  worked: "ids_in_progress",
  push: "open",
  resolved: "resolved",
};

const LABELS: Record<IssueAction, string> = {
  worked: "worked",
  push: "push next week",
  resolved: "resolved",
};

const ACTIVE_STYLES: Record<IssueAction, string> = {
  worked: "border-amber-500/50 bg-amber-500/20 text-amber-100",
  push: "border-border bg-muted/40 text-muted-foreground",
  resolved: "border-emerald-500/40 bg-emerald-500/15 text-emerald-100",
};

const INACTIVE_STYLES =
  "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground";

export function IssueActionButtons({
  issueId,
  status,
  readOnly,
}: {
  issueId: string;
  status: IssueStatus;
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) {
    const action = (Object.keys(ACTIVE_STATUS_FOR_ACTION) as IssueAction[]).find(
      (a) => ACTIVE_STATUS_FOR_ACTION[a] === status,
    );
    return (
      <span
        className={cn(
          "inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
          action ? ACTIVE_STYLES[action] : INACTIVE_STYLES,
        )}
      >
        {action ? LABELS[action] : status}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {(Object.keys(ACTIVE_STATUS_FOR_ACTION) as IssueAction[]).map((a) => {
        const isActive = ACTIVE_STATUS_FOR_ACTION[a] === status;
        return (
          <button
            key={a}
            type="button"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const r = await updateIssueStatus({ issueId, action: a });
                if (!r.ok) {
                  setError(r.error);
                  return;
                }
                router.refresh();
              });
            }}
            className={cn(
              "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-50",
              isActive ? ACTIVE_STYLES[a] : INACTIVE_STYLES,
            )}
          >
            {LABELS[a]}
          </button>
        );
      })}
      {pending && <span className="font-mono text-[10px] text-muted-foreground">…</span>}
      {error && <span className="font-mono text-[10px] text-rose-300">{error}</span>}
    </div>
  );
}
