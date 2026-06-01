import { cn } from "@/lib/utils";
import type { StatusColor } from "@/lib/shading/types";

const STATUS_VAR: Record<StatusColor, string> = {
  green: "--status-green",
  yellow: "--status-yellow",
  red: "--status-red",
};

/** Dramatic, space-filling area/wave rendered as a single inline SVG — no
 *  charting dependency. Stretches full-bleed (preserveAspectRatio="none")
 *  so it fills its container. Color is driven by the metric's status; red
 *  (== Signal Red) reads as the hot accent. Nulls in the series are skipped;
 *  fewer than two real points renders nothing. Pure/server-safe — the
 *  gradient id is derived from `id`, not a hook. */
export function WaveChart({
  series,
  status,
  id,
  className,
}: {
  series: (number | null)[];
  status: StatusColor | null;
  id: string;
  className?: string;
}) {
  const pts = series
    .map((v, i) => ({ i, v }))
    .filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length < 2) return null;

  const W = 100;
  const H = 40;
  const xs = pts.map((p) => p.i);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const vals = pts.map((p) => p.v);
  let minV = Math.min(...vals);
  let maxV = Math.max(...vals);
  if (minV === maxV) {
    // Flat series — give it a hairline band so the line sits mid-height.
    minV -= 1;
    maxV += 1;
  }
  const sx = (i: number) => ((i - minX) / (maxX - minX)) * W;
  const sy = (v: number) => H - 2 - ((v - minV) / (maxV - minV)) * (H - 4);

  const line = pts
    .map((p, k) => `${k === 0 ? "M" : "L"}${sx(p.i).toFixed(2)},${sy(p.v).toFixed(2)}`)
    .join(" ");
  const area = `${line} L${sx(maxX).toFixed(2)},${H} L${sx(minX).toFixed(2)},${H} Z`;

  const v = status ? STATUS_VAR[status] : "--muted-foreground";
  const color = `hsl(var(${v}))`;
  const gid = `wave-${id}`;

  return (
    <svg
      aria-hidden
      className={cn("h-full w-full", className)}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.5" />
          <stop offset="60%" stopColor={color} stopOpacity="0.14" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
