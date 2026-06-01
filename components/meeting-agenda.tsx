"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SurfaceBlock } from "@/components/ui/surface-block";
import { cn } from "@/lib/utils";

export interface AgendaSegment {
  key: string;
  name: string;
  minutes: number;
  href: string | null;
  desc: string;
}

function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** The L10 agenda as bold labeled bands. When a meeting is live, a 1s timer
 *  highlights the current segment (anchored on the live meeting's start) and
 *  shows time remaining; the active band is the one place red appears. With
 *  no live meeting it's a static, scannable agenda. */
export function MeetingAgenda({
  segments,
  startedAtMs,
}: {
  segments: AgendaSegment[];
  startedAtMs: number | null;
}) {
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setMounted(true);
    if (startedAtMs == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAtMs]);

  const total = segments.reduce((s, x) => s + x.minutes, 0);
  const starts: number[] = [];
  let acc = 0;
  for (const seg of segments) {
    starts.push(acc);
    acc += seg.minutes;
  }

  const live = mounted && startedAtMs != null;
  const elapsedMin = live ? (now - startedAtMs) / 60_000 : 0;
  const overrun = live && elapsedMin >= total;
  const activeIndex = !live
    ? -1
    : overrun
      ? segments.length - 1
      : segments.findIndex(
          (s, i) => elapsedMin >= starts[i]! && elapsedMin < starts[i]! + s.minutes,
        );

  return (
    <div className="space-y-3">
      {live && (
        <div className="flex items-baseline justify-between rounded-[2px] border border-signal/40 bg-signal/10 px-4 py-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-signal">
            ● live · meeting clock
          </span>
          <span className="font-mono tabular text-2xl font-semibold leading-none text-foreground">
            {clock((now - startedAtMs!) / 1000)}
            <span className="ml-2 text-[11px] text-muted-foreground">
              / {total}:00
            </span>
          </span>
        </div>
      )}

      {segments.map((seg, i) => {
        const active = i === activeIndex;
        const remainingMin = live
          ? starts[i]! + seg.minutes - elapsedMin
          : seg.minutes;
        return (
          <SurfaceBlock key={seg.key} status={active ? "red" : "neutral"}>
            <div className="flex items-center gap-4">
              <span className="w-8 shrink-0 font-display text-2xl leading-none text-muted-foreground/40">
                {i + 1}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-display text-xl uppercase leading-none tracking-[0.01em] text-foreground">
                    {seg.name}
                  </span>
                  {active && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-signal">
                      now
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {seg.desc}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <span
                  className={cn(
                    "font-mono tabular text-lg font-semibold leading-none",
                    active ? "text-signal" : "text-foreground",
                  )}
                >
                  {active ? clock(Math.max(0, remainingMin) * 60) : `${seg.minutes}`}
                </span>
                <div className="eyebrow mt-1">{active ? "left" : "min"}</div>
              </div>

              {seg.href && (
                <Link
                  href={seg.href}
                  className="focus-ring shrink-0 rounded-[2px] border border-border bg-surface-2 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                >
                  open
                </Link>
              )}
            </div>
          </SurfaceBlock>
        );
      })}
    </div>
  );
}
