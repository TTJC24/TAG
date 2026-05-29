"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

/** Toggles ?meeting=1 in the URL. Sets a body data attribute so global
 *  styles (panel padding, hidden chrome, oversized numerics) can switch
 *  in/out without re-rendering every page. */
export function MeetingModeToggle({ className }: { className?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const on = params.get("meeting") === "1";

  // Set the body data attribute so app/globals.css can scope styles to it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.dataset.meeting = on ? "1" : "";
    return () => {
      if (typeof document !== "undefined") document.body.dataset.meeting = "";
    };
  }, [on]);

  const next = new URLSearchParams(params.toString());
  if (on) next.delete("meeting");
  else next.set("meeting", "1");
  const href = `${pathname}${next.toString() ? `?${next.toString()}` : ""}`;

  return (
    <Link
      href={href}
      title={on ? "exit meeting mode" : "enter meeting mode"}
      aria-pressed={on}
      className={cn(
        "focus-ring flex items-center gap-1.5 rounded-[2px] border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors",
        on
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-surface-2 text-muted-foreground hover:border-border-strong hover:text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          on
            ? "bg-background animate-[pulse-status_2s_ease-in-out_infinite]"
            : "bg-muted-foreground/50",
        )}
      />
      meeting mode
    </Link>
  );
}
