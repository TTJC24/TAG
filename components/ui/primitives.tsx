// Operational primitive components shared across every tab.
// Single coherent system — owner chip, status chip, missing marker,
// trend strip, panel header. No card-grid sprawl.

import type { ReactNode } from "react";
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

// ── Command strip — canonical page header: eyebrow + title + right slot ─────
// The single operational page header used across every surface. Owns the
// border/spacing rhythm so surfaces stay visually consistent; per-surface
// summary bars, filters, and primary actions are passed via `right`.

export function CommandStrip({
  eyebrow,
  title,
  right,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4",
        className,
      )}
    >
      <div className="space-y-1">
        {eyebrow != null && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      {right != null && (
        <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-3">
          {right}
        </div>
      )}
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

// ── Status dot — 1.5×1.5 round semaphore for dense headers/rows ─────────────

export function StatusDot({
  status,
  className,
  pulse,
}: {
  status: "green" | "yellow" | "red" | "muted";
  className?: string;
  pulse?: boolean;
}) {
  const bg =
    status === "muted" ? "bg-muted-foreground/50" : `bg-status-${status}`;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        bg,
        pulse && "animate-[pulse-status_2s_ease-in-out_infinite]",
        className,
      )}
    />
  );
}

// ── Metric stat — eyebrow label over an oversized numeric reading ───────────

const METRIC_TONE: Record<
  "green" | "yellow" | "red" | "muted" | "neutral",
  string
> = {
  green: "text-status-green",
  yellow: "text-status-yellow",
  red: "text-status-red",
  muted: "text-muted-foreground",
  neutral: "text-foreground",
};

export function MetricStat({
  label,
  value,
  tone = "neutral",
  delta,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: "green" | "yellow" | "red" | "muted" | "neutral";
  delta?: { sign: -1 | 0 | 1; text: string };
  className?: string;
}) {
  const deltaCls =
    delta == null
      ? ""
      : delta.sign > 0
        ? "text-emerald-400"
        : delta.sign < 0
          ? "text-rose-400"
          : "text-muted-foreground";
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="eyebrow">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className={cn("numeric-xl meeting-numeric", METRIC_TONE[tone])}>
          {value}
        </span>
        {delta && (
          <span className={cn("numeric-sm", deltaCls)}>{delta.text}</span>
        )}
      </div>
    </div>
  );
}

// ── Summary bar — horizontal row of metric stats / status chips ─────────────

export function SummaryBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-4", className)}>
      {children}
    </div>
  );
}

// ── Data table — dense h-9 operational table (h-11 in meeting mode) ─────────

export function DataTable({
  children,
  className,
  sticky,
}: {
  children: ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <table
      className={cn(
        "w-full border-collapse text-sm",
        sticky && "[&_thead]:sticky [&_thead]:top-[var(--topbar-h,3rem)] [&_thead]:z-10",
        className,
      )}
    >
      {children}
    </table>
  );
}

export function Th({
  children,
  align = "left",
  sortable,
  sortDir,
  onSort,
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  sortable?: boolean;
  sortDir?: "asc" | "desc" | null;
  onSort?: () => void;
  className?: string;
}) {
  const alignCls =
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const inner = (
    <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
      {children}
      {sortable && (
        <span aria-hidden className="font-mono text-[9px] text-muted-foreground/70">
          {sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕"}
        </span>
      )}
    </span>
  );
  return (
    <th
      scope="col"
      aria-sort={
        sortable
          ? sortDir === "asc"
            ? "ascending"
            : sortDir === "desc"
              ? "descending"
              : "none"
          : undefined
      }
      className={cn(
        "h-8 border-b border-border bg-surface-1 px-3 align-middle font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground",
        alignCls,
        className,
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className="focus-ring inline-flex items-center gap-1 rounded uppercase tracking-[0.16em] transition hover:text-foreground"
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  numeric,
  className,
  title,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  numeric?: boolean;
  className?: string;
  title?: string;
}) {
  const alignCls = numeric
    ? "text-right"
    : align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";
  return (
    <td
      title={title}
      className={cn(
        "px-3 align-middle",
        numeric && "font-mono tabular",
        alignCls,
        className,
      )}
    >
      {children}
    </td>
  );
}

// ── Key hint — mono kbd badge for keyboard affordances ──────────────────────

export function KeyHint({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-surface-3 px-1 font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ── Segmented control — pure-client pill toggle group ───────────────────────

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded border border-border bg-surface-1 p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "focus-ring inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] transition",
              active
                ? "bg-surface-3 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
            {typeof opt.count === "number" && (
              <span className="tabular text-[10px] text-muted-foreground/80">
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Brain badge — --brain-tinted chip for KB provenance only ────────────────

export function BrainBadge({
  children = "brain",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-[hsl(var(--brain)/0.4)] bg-[hsl(var(--brain)/0.12)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[hsl(var(--brain))]",
        className,
      )}
    >
      {children}
    </span>
  );
}
