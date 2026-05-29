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

// IDS workflow verbs — these are load-bearing and must not be renamed.
const LABELS: Record<IssueAction, string> = {
  worked: "worked",
  push: "push next week",
  resolved: "resolved",
};

const ACTIVE_STYLES: Record<IssueAction, string> = {
  worked: "border-amber-500/50 bg-amber-500/15 text-amber-200",
  push: "border-border bg-surface-3 text-foreground",
  resolved: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
};

const INACTIVE_STYLES =
  "border-border bg-surface-2 text-muted-foreground hover:border-foreground/30 hover:bg-surface-3 hover:text-foreground";

const BTN_BASE =
  "focus-ring rounded border px-2 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.16em] transition disabled:opacity-50";

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
          "inline-flex items-center rounded border px-2 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.16em]",
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
            aria-pressed={isActive}
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
            className={cn(BTN_BASE, isActive ? ACTIVE_STYLES[a] : INACTIVE_STYLES)}
          >
            {LABELS[a]}
          </button>
        );
      })}
      {pending && (
        <span className="font-mono text-[10px] leading-none text-muted-foreground">
          …
        </span>
      )}
      {error && (
        <span className="font-mono text-[10px] leading-none text-rose-300">
          {error}
        </span>
      )}
    </div>
  );
}
