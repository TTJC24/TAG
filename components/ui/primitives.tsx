// Operational primitive components shared across every tab.
// Single coherent system — owner chip, status chip, missing marker,
// trend strip, panel header. No card-grid sprawl.

import { cn } from "@/lib/utils";

// ── Owner chip ───────────────────────────────────────────────────────────────

export function OwnerChip({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  if (!name) {
    return <span className={cn("font-mono text-xs text-muted-foreground/60", className)}>—</span>;
  }
  // Initials prefix for high-density scan; full name for accessibility.
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span className={cn("owner-chip", className)} title={name}>
      <span className="font-mono text-[9px] tracking-[0.18em] text-muted-foreground">
        {initials}
      </span>
      <span>{name}</span>
    </span>
  );
}

// ── Status chip ──────────────────────────────────────────────────────────────

export type StatusTone = "green" | "yellow" | "red" | "muted";

const TONE_CLASS: Record<StatusTone, string> = {
  green: "chip-green",
  yellow: "chip-yellow",
  red: "chip-red",
  muted: "chip-muted",
};

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("chip", TONE_CLASS[tone], className)}>{children}</span>;
}

// ── Missing marker ───────────────────────────────────────────────────────────

export function MissingMarker({
  label = "missing",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return <span className={cn("missing", className)}>{label}</span>;
}

// ── Trend strip — compact 3-week sparkline using deltas, no chart lib ───────
// Renders one cell per week with a small bar showing direction-relative
// performance vs goal. `points` is oldest-first.

export interface TrendPoint {
  weekEndingDate: string;
  actual: number | null;
  /** -1 = below goal, 0 = on, 1 = above. null = no entry. */
  toneSign: -1 | 0 | 1 | null;
}

export function TrendStrip({
  points,
  className,
}: {
  points: TrendPoint[];
  className?: string;
}) {
  return (
    <div className={cn("flex items-end gap-1", className)} aria-hidden>
      {points.map((p, i) => {
        const sign = p.toneSign;
        const cls =
          sign === null
            ? "h-1 w-3 rounded-sm bg-border"
            : sign > 0
              ? "h-3 w-3 rounded-sm bg-emerald-500/70"
              : sign < 0
                ? "h-3 w-3 rounded-sm bg-rose-500/70"
                : "h-2 w-3 rounded-sm bg-amber-500/70";
        return <span key={i} className={cls} title={`${p.weekEndingDate}: ${p.actual ?? "—"}`} />;
      })}
    </div>
  );
}

// ── Panel + section header ───────────────────────────────────────────────────

export function Panel({
  children,
  className,
  tight,
}: {
  children: React.ReactNode;
  className?: string;
  tight?: boolean;
}) {
  return <section className={cn(tight ? "panel-tight" : "panel", className)}>{children}</section>;
}

export function PanelHeader({
  title,
  count,
  hint,
  right,
}: {
  title: string;
  count?: number;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="panel-header">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {typeof count === "number" && (
          <span className="font-mono text-[11px] tabular text-muted-foreground/80">
            {count}
          </span>
        )}
        {hint && <span className="eyebrow">{hint}</span>}
      </div>
      {right && <div className="flex items-center gap-3">{right}</div>}
    </header>
  );
}

// ── Empty block — no decorative dashed-border boxes anywhere ────────────────

export function EmptyBlock({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("px-4 py-6 text-center text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}

// ── Eyebrow caption ──────────────────────────────────────────────────────────

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("eyebrow", className)}>{children}</p>;
}
