"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

/** Client nav strip. Highlights the active route (TopBar is a server
 *  component, so route awareness lives here) and wires a cheap `g`-then-key
 *  jump (g s/r/t/i) for keyboard-first operators. No data fetching. */
export function TopBarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const router = useRouter();

  // `g`-leader jump: press `g`, then a section key. Ignored while typing.
  useEffect(() => {
    let armed = false;
    let armedAt = 0;
    const JUMP: Record<string, string> = {
      d: "/",
      s: "/scorecard",
      r: "/rocks",
      t: "/todos",
      i: "/issues",
    };
    function isEditable(el: EventTarget | null): boolean {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        node.isContentEditable
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      if (e.key === "g") {
        armed = true;
        armedAt = Date.now();
        return;
      }
      if (armed && Date.now() - armedAt < 1200) {
        const dest = JUMP[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          router.push(dest);
        }
      }
      armed = false;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <nav className="flex items-center gap-1 text-[13px]">
      {items.map((n) => {
        // "/" must match exactly — startsWith("/") would match every route.
        const active =
          n.href === "/"
            ? pathname === "/"
            : pathname === n.href || pathname.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative px-2.5 py-1.5 transition-colors focus-ring",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {n.label}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-2.5 bottom-0 h-[2px] bg-foreground"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
