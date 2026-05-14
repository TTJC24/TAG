"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateRockStatus } from "@/lib/server-actions/rocks";

type RockStatus = "on_track" | "off_track" | "still_going" | "completed";

const NEXT: Record<RockStatus, RockStatus> = {
  on_track: "off_track",
  off_track: "still_going",
  still_going: "completed",
  completed: "on_track",
};

function colorFor(status: RockStatus): string {
  switch (status) {
    case "on_track":
      return "bg-status-green/15 text-status-green";
    case "off_track":
      return "bg-status-red/15 text-status-red";
    case "still_going":
      return "bg-status-yellow/15 text-status-yellow";
    case "completed":
      return "bg-muted text-muted-foreground";
  }
}

interface RockStatusPillProps {
  rockId: string;
  status: RockStatus;
  readOnly?: boolean;
}

/** Clicking cycles on_track → off_track → completed → on_track. The
 *  server action handles the audit log; we just `router.refresh()`. */
export function RockStatusPill({ rockId, status, readOnly }: RockStatusPillProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) {
    return (
      <span
        className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${colorFor(status)}`}
      >
        {status.replace("_", " ")}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {error && (
        <span className="font-mono text-[10px] text-red-500">{error}</span>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await updateRockStatus({ rockId, status: NEXT[status] });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        disabled={pending}
        className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-50 ${colorFor(status)}`}
        title="click to cycle status"
      >
        {pending ? "…" : status.replace("_", " ")}
      </button>
    </span>
  );
}
