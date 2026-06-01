import type { ReactNode } from "react";
import type { StatusColor } from "@/lib/shading/types";
import { cn } from "@/lib/utils";

/** Block status. The data-ink triad drives the border; "neutral" is a plain
 *  hairline; "muted" is the done/solved treatment (dashed, recessive). */
export type BlockStatus = StatusColor | "neutral" | "muted";

/** The single source of truth for a block's status border. Every surface
 *  (scorecard, rocks, issues, todos, readiness, landing) borders the same way:
 *  a hairline in the status hue plus a 3px left accent. Signal Red == critical. */
export function statusBorder(status: BlockStatus): string {
  switch (status) {
    case "red":
      return "border-status-red/50 border-l-[3px] border-l-status-red";
    case "yellow":
      return "border-status-yellow/40 border-l-[3px] border-l-status-yellow";
    case "green":
      return "border-status-green/35 border-l-[3px] border-l-status-green";
    case "muted":
      return "border-dashed border-border/70";
    case "neutral":
    default:
      return "border-border";
  }
}

/** The shared block shell. Near-black surface, hairline/accent border by
 *  status, crisp radius, generous padding — the canonical container for the
 *  whole app. Surfaces compose their own content inside it. */
export function SurfaceBlock({
  status = "neutral",
  className,
  children,
}: {
  status?: BlockStatus;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[2px] border bg-surface-1 p-4 transition-colors",
        statusBorder(status),
        className,
      )}
    >
      {children}
    </div>
  );
}
