"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Visible, persistent LIGHT | DARK toggle in the masthead. Persists via
 *  next-themes (localStorage). Mount-guarded: before hydration we render a
 *  same-size placeholder so there's no layout shift or theme mismatch flash. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        aria-hidden
        className="h-7 w-[92px] rounded-[2px] border border-border bg-surface-1"
      />
    );
  }

  const isDark = resolvedTheme === "dark";
  const seg =
    "focus-ring rounded-[1px] px-2 py-0.5 transition-colors";
  const on = "bg-foreground text-background";
  const off = "text-muted-foreground hover:text-foreground";

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex items-center gap-0.5 rounded-[2px] border border-border bg-surface-1 p-0.5 font-mono text-[10px] uppercase tracking-[0.16em]"
    >
      <button
        type="button"
        aria-pressed={!isDark}
        onClick={() => setTheme("light")}
        className={cn(seg, isDark ? off : on)}
      >
        Light
      </button>
      <button
        type="button"
        aria-pressed={isDark}
        onClick={() => setTheme("dark")}
        className={cn(seg, isDark ? on : off)}
      >
        Dark
      </button>
    </div>
  );
}
