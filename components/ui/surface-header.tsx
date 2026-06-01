import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The canonical surface masthead: a mono eyebrow, a huge Anton nameplate,
 *  and a right-aligned cluster of stats / actions. Every primary surface
 *  uses this so the type treatment is identical everywhere. */
export function SurfaceHeader({
  eyebrow,
  title,
  sub,
  children,
}: {
  eyebrow: string;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      <p className="eyebrow">{eyebrow}</p>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.75rem)] uppercase leading-[0.9] tracking-[0.01em] text-foreground">
          {title}
        </h1>
        {children && <div className="flex items-end gap-6">{children}</div>}
      </div>
      {sub && <p className="eyebrow text-muted-foreground/70">{sub}</p>}
    </header>
  );
}

/** A single bold stat in a surface header. `hero` makes it the dominant
 *  reading (e.g. on-track count); the rest are smaller supporting counts. */
export function StatNumber({
  value,
  label,
  tone = "default",
  hero = false,
}: {
  value: ReactNode;
  label: string;
  tone?: "default" | "red" | "yellow" | "green" | "muted";
  hero?: boolean;
}) {
  return (
    <div className="flex flex-col items-start">
      <span
        className={cn(
          "font-mono tabular font-semibold leading-none",
          hero
            ? "text-[clamp(1.75rem,4vw,2.5rem)]"
            : "text-[clamp(1.25rem,3vw,1.75rem)]",
          tone === "red"
            ? "text-status-red"
            : tone === "yellow"
              ? "text-status-yellow"
              : tone === "green"
                ? "text-status-green"
                : tone === "muted"
                  ? "text-muted-foreground"
                  : "text-foreground",
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "eyebrow mt-1.5",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}
