"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { StatNumber } from "@/components/ui/surface-header";
import { statusBorder } from "@/components/ui/surface-block";
import type { EntityHealth } from "@/lib/queries/dashboard";
import { cn } from "@/lib/utils";

const VERDICT: Record<EntityHealth["signal"], string> = {
  green: "on track",
  yellow: "needs attention",
  red: "critical",
};

/** A bold per-entity band on the landing dashboard. Clicking it drills in:
 *  if the entity isn't the active org, it switches the active Clerk org first,
 *  then opens that entity's scorecard. */
export function EntityBand({
  name,
  code,
  role,
  clerkOrgId,
  isActive,
  health,
}: {
  name: string;
  code: string;
  role: string;
  clerkOrgId: string;
  isActive: boolean;
  health: EntityHealth;
}) {
  const { setActive } = useClerk();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function drillIn() {
    startTransition(async () => {
      if (!isActive && setActive) {
        await setActive({ organization: clerkOrgId });
      }
      router.push("/scorecard");
    });
  }

  return (
    <button
      type="button"
      onClick={drillIn}
      disabled={pending}
      aria-label={`Open ${name}`}
      className={cn(
        "group w-full rounded-[2px] border bg-surface-1 p-5 text-left transition-colors hover:bg-surface-2 focus-ring disabled:opacity-60",
        statusBorder(health.signal),
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-[clamp(2rem,4.5vw,3.25rem)] uppercase leading-none tracking-[0.01em] text-foreground">
              {name}
            </span>
            <span className="eyebrow">{code}</span>
            {isActive && <span className="eyebrow text-muted-foreground/70">active</span>}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span
              className={cn(
                "font-mono text-[11px] uppercase tracking-[0.18em]",
                health.signal === "red"
                  ? "text-status-red"
                  : health.signal === "yellow"
                    ? "text-status-yellow"
                    : "text-status-green",
              )}
            >
              {VERDICT[health.signal]}
            </span>
            <span className="eyebrow text-muted-foreground/60">{role}</span>
          </div>
        </div>

        <div className="flex items-end gap-6">
          <StatNumber
            value={`${health.onTrack}/${health.total}`}
            label="on track"
            tone={health.signal}
            hero
          />
          <StatNumber value={health.critical} label="critical" tone="red" />
          <StatNumber value={health.watch} label="watch" tone="yellow" />
          <StatNumber value={health.openIssues} label="issues" tone="muted" />
          <StatNumber
            value={health.rocksOff}
            label="rocks off"
            tone={health.rocksOff > 0 ? "red" : "muted"}
          />
        </div>

        <span className="eyebrow text-muted-foreground/40 transition-opacity group-hover:text-foreground">
          {pending ? "opening…" : "view →"}
        </span>
      </div>
    </button>
  );
}
