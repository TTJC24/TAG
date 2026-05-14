import Link from "next/link";
import { OrganizationSwitcher, UserButton, SignedIn } from "@clerk/nextjs";
import { tryGetAuthContext } from "@/lib/auth/context";
import { getRecentWeeks } from "@/lib/queries/me";
import { MeetingModeToggle } from "@/components/meeting-mode-toggle";
import { cn } from "@/lib/utils";

const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/scorecard", label: "Scorecard" },
  { href: "/rocks", label: "Rocks" },
  { href: "/todos", label: "To-Do's" },
  { href: "/issues", label: "Issues" },
  { href: "/admin/readiness", label: "Readiness", adminOnly: true },
];

/** Top shell. Two stacked rows:
 *    Row 1: brand · nav · org switcher / meeting toggle / user
 *    Row 2: current week + meeting context (org-scoped, slim caption strip)
 *  The second row is hidden in meeting mode (chrome stripped). */
export async function TopBar() {
  const ctx = await tryGetAuthContext();
  const items = NAV.filter((n) => !n.adminOnly || ctx?.role === "admin");
  const weeks = ctx ? await getRecentWeeks(1) : [];
  const currentWeek = weeks[0] ?? null;

  return (
    <SignedIn>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        {/* Row 1 — brand + nav + identity controls */}
        <div className="container flex h-11 items-center gap-6">
          <Link
            href="/scorecard"
            className="font-mono text-[11px] uppercase tracking-[0.22em] text-foreground"
          >
            tractionos
          </Link>
          <nav className="flex items-center gap-1 text-[13px]">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded px-2.5 py-1 text-muted-foreground transition hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <MeetingModeToggle />
            <OrganizationSwitcher
              hidePersonal
              appearance={{
                elements: {
                  rootBox: "shrink-0",
                  organizationSwitcherTrigger:
                    "rounded border border-border bg-card px-2 py-1 text-[11px] uppercase tracking-[0.18em]",
                },
              }}
            />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </div>

        {/* Row 2 — operational context strip. Hidden in meeting mode. */}
        {ctx && (
          <div className="meeting-hide container flex h-7 items-center gap-5 border-t border-border/60 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span className="font-mono text-foreground/90">{ctx.orgName}</span>
            <span aria-hidden className="text-border">·</span>
            <span className="font-mono">
              week {currentWeek ? currentWeek.weekEndingDate : "—"}
            </span>
            <span aria-hidden className="text-border">·</span>
            <span className="font-mono">
              quarter {currentWeek?.quarter ?? "—"}
            </span>
            <span className="ml-auto font-mono text-muted-foreground/70">
              {ctx.personName}
            </span>
          </div>
        )}
      </header>
    </SignedIn>
  );
}
