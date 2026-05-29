import { cn } from "@/lib/utils";
import type { ReadinessResult } from "@/lib/readiness/compute-readiness";
import { StatusDot, MetricStat } from "@/components/ui/primitives";

interface ReadinessBannerProps {
  result: ReadinessResult;
  /** ISO date for the next L10, or null when none scheduled. */
  nextMeetingDate: string | null;
}

// Hero frame tint per readiness status — status semantics only.
const FRAME_STYLES: Record<ReadinessResult["status"], string> = {
  green: "border-status-green/25 bg-status-green/[0.06]",
  yellow: "border-status-yellow/25 bg-status-yellow/[0.06]",
  red: "border-status-red/25 bg-status-red/[0.06]",
};

// Map readiness status → headline text tone (value emphasis only).
const HEADLINE_STYLES: Record<ReadinessResult["status"], string> = {
  green: "text-status-green",
  yellow: "text-status-yellow",
  red: "text-status-red",
};

/** Pre-meeting readiness hero rendered at the top of /me. Cheap, server-only,
 *  computed from the data already loaded for the page. Re-skinned into a
 *  command-center hero: status dot + headline + a row of metric reads. */
export function ReadinessBanner({ result, nextMeetingDate }: ReadinessBannerProps) {
  const next = nextMeetingDate ? formatMeetingDate(nextMeetingDate) : null;
  const entered = result.totalMeasurables - result.missingMeasurables;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded border px-5 py-4",
        FRAME_STYLES[result.status],
      )}
      role="status"
    >
      <div className="flex items-center gap-3">
        <StatusDot status={result.status} pulse={result.status === "red"} />
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            meeting readiness
          </span>
          <span
            className={cn(
              "text-base font-semibold tracking-tight",
              HEADLINE_STYLES[result.status],
            )}
          >
            {result.label}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <MetricStat
          label="measurables"
          value={`${entered}/${result.totalMeasurables}`}
          tone={result.missingMeasurables > 0 ? "yellow" : "green"}
        />
        <MetricStat
          label="overdue to-do's"
          value={result.overdueTodos}
          tone={result.overdueTodos > 0 ? "red" : "neutral"}
        />
        <MetricStat label="next L10" value={next ?? "not scheduled"} />
      </div>
    </div>
  );
}

function formatMeetingDate(iso: string): string {
  // ISO timestamp from Postgres. Render as "Tue May 19".
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
