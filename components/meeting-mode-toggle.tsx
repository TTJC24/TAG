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
      className={cn(
        "flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition",
        on
          ? "border-amber-500/50 bg-amber-500/10 text-amber-100"
          : "border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-amber-400" : "bg-muted-foreground/50")}
      />
      meeting mode
    </Link>
  );
}
