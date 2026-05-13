import { cn } from "@/lib/utils";
import type { ReadinessResult } from "@/lib/readiness/compute-readiness";

interface ReadinessBannerProps {
  result: ReadinessResult;
  /** ISO date for the next L10, or null when none scheduled. */
  nextMeetingDate: string | null;
}

const STATUS_STYLES: Record<ReadinessResult["status"], string> = {
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
  yellow: "border-amber-500/30 bg-amber-500/10 text-amber-100",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-100",
};

const DOT_STYLES: Record<ReadinessResult["status"], string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
};

/** Pre-meeting readiness pill rendered at the top of /me. Cheap, server-only,
 *  computed from the data already loaded for the page. */
export function ReadinessBanner({ result, nextMeetingDate }: ReadinessBannerProps) {
  const next = nextMeetingDate ? formatMeetingDate(nextMeetingDate) : null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded border px-4 py-3 text-sm",
        STATUS_STYLES[result.status],
      )}
      role="status"
    >
      <div className="flex items-center gap-3">
        <span className={cn("h-2.5 w-2.5 rounded-full", DOT_STYLES[result.status])} />
        <span className="font-medium">{result.label}</span>
      </div>
      <div className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-widest">
        <span>
          {result.totalMeasurables - result.missingMeasurables}/
          {result.totalMeasurables} measurables
        </span>
        <span>{result.overdueTodos} overdue</span>
        <span className="opacity-80">
          Next L10: {next ?? "not scheduled"}
        </span>
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
