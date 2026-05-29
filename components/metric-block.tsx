"use client";

import type { ReactNode } from "react";
import { EditableEntryCell } from "@/components/editable-entry-cell";
import { EditableGoalCell } from "@/components/editable-goal-cell";
import { WaveChart } from "@/components/wave-chart";
import { OwnerChip } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { GoalDirection, ShadingResult, StatusColor } from "@/lib/shading/types";

export interface MetricBlockProps {
  measurableId: string;
  weekId: string | null;
  name: string;
  ownerName: string | null;
  currentActual: number | null;
  currentNote: string | null;
  /** Formatted current value, or "" when unset. */
  display: string;
  status: StatusColor | null;
  result: ShadingResult | null;
  /** ~12-week series (sparse — nulls allowed) feeding the wave. */
  series: (number | null)[];
  goalDirection: GoalDirection;
  goalValue: number | null;
  goalSecondary: number | null;
  formatHint: string | null;
  readOnly: boolean;
  /** KPI controls slot (rendered visibly, top-right). */
  children?: ReactNode;
}

const STATUS_BORDER: Record<StatusColor, string> = {
  red: "border-status-red/50 border-l-[3px] border-l-status-red",
  yellow: "border-status-yellow/40 border-l-[3px] border-l-status-yellow",
  green: "border-status-green/35 border-l-[3px] border-l-status-green",
};

export function MetricBlock({
  measurableId,
  weekId,
  name,
  ownerName,
  currentActual,
  currentNote,
  display,
  status,
  result,
  series,
  goalDirection,
  goalValue,
  goalSecondary,
  formatHint,
  readOnly,
  children,
}: MetricBlockProps) {
  const missing = currentActual === null;

  const hero = (
    <span
      className={cn(
        "block font-mono tabular leading-[0.95] tracking-tight",
        "text-[clamp(2.5rem,3.5vw,4rem)]",
        missing ? "text-muted-foreground/35" : "text-foreground",
      )}
    >
      {missing ? "—" : display}
    </span>
  );

  return (
    <div
      className={cn(
        "group relative flex min-h-[11rem] flex-col overflow-hidden rounded-[2px] border bg-surface-1 p-4 transition-colors",
        status ? STATUS_BORDER[status] : "border-dashed border-border",
      )}
    >
      {/* full-bleed dramatic wave */}
      {status && (
        <div className="pointer-events-none absolute inset-0">
          <WaveChart series={series} status={status} id={measurableId} />
        </div>
      )}
      {/* top scrim keeps the eyebrow + hero number legible over the wave */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-gradient-to-b from-surface-1 via-surface-1/60 to-transparent"
      />

      <div className="relative z-10 flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <span className="eyebrow truncate pt-0.5">{name}</span>
          <div className="flex shrink-0 items-center gap-2">
            <OwnerChip name={ownerName} />
            {children}
          </div>
        </div>

        <div className="mt-3">
          <EditableEntryCell
            measurableId={measurableId}
            weekId={weekId ?? ""}
            currentActual={currentActual}
            currentNote={currentNote}
            display={missing ? "—" : display}
            result={result}
            readOnly={readOnly || !weekId}
            displayNode={hero}
          />
        </div>

        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <span className="font-mono uppercase tracking-[0.14em] text-muted-foreground">
            goal
          </span>
          <EditableGoalCell
            measurableId={measurableId}
            goalDirection={goalDirection}
            goalValue={goalValue}
            goalSecondary={goalSecondary}
            formatHint={formatHint}
            readOnly={readOnly}
          />
        </div>

        <div className="flex-1" />

        {missing && (
          <span className="eyebrow text-muted-foreground/55">awaiting entry</span>
        )}
      </div>
    </div>
  );
}
