// Shaded cell renderer. Server-safe — accepts the pre-computed shading
// result and the formatted display string and renders the visual cell.

import { cn } from "@/lib/utils";
import type { ShadingResult } from "@/lib/shading/types";

interface StatusCellProps {
  display: string;
  result: ShadingResult | null;
  className?: string;
  /** Title text shown on hover; usually result.reason. */
  title?: string;
}

export function StatusCell({ display, result, className, title }: StatusCellProps) {
  const intensity = result ? Math.max(0, Math.min(100, result.intensity)) : 0;
  const channel = result?.status ?? "yellow";
  const bg =
    result === null
      ? undefined
      : `hsl(var(--status-${channel}) / ${(intensity / 100).toFixed(2)})`;

  return (
    <div
      className={cn(
        "relative inline-flex min-h-[2.25rem] min-w-[5rem] items-center justify-center rounded px-2 py-1 font-mono text-sm tabular",
        className,
      )}
      style={bg ? { backgroundColor: bg } : undefined}
      title={title ?? result?.reason}
    >
      <span className="z-10">{display}</span>
      {result?.forecast === "warning" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded ring-1 ring-amber-500/60"
        />
      )}
    </div>
  );
}
