"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateRockStatus } from "@/lib/server-actions/rocks";
import { cn } from "@/lib/utils";

const OPTIONS: { value: RockStatus; label: string }[] = [
  { value: "on_track", label: "On Track" },
  { value: "off_track", label: "Off Track" },
  { value: "still_going", label: "Still Going" },
  { value: "completed", label: "Done" },
];

const STYLES: Record<RockStatus, string> = {
  on_track: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
  off_track: "border-rose-500/30 bg-rose-500/10 text-rose-100",
  still_going: "border-amber-500/30 bg-amber-500/10 text-amber-100",
  completed: "border-border bg-muted/30 text-muted-foreground",
};

type RockStatus = "on_track" | "off_track" | "still_going" | "completed";

export function RockStatusSelect({
  rockId,
  status,
  readOnly,
}: {
  rockId: string;
  status: RockStatus;
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  if (readOnly) {
    const label = OPTIONS.find((o) => o.value === status)?.label ?? status;
    return (
      <span
        className={cn(
          "inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
          STYLES[status],
        )}
      >
        {label}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={status}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as RockStatus;
          setError(null);
          startTransition(async () => {
            const r = await updateRockStatus({ rockId, status: next });
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
        className={cn(
          "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-ring",
          STYLES[status],
        )}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value} className="bg-background text-foreground">
            {o.label}
          </option>
        ))}
      </select>
      {pending && <span className="font-mono text-[10px] text-muted-foreground">…</span>}
      {error && <span className="font-mono text-[10px] text-rose-300">{error}</span>}
    </div>
  );
}
