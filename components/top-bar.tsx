import Link from "next/link";
import { OrganizationSwitcher, UserButton, SignedIn } from "@clerk/nextjs";
import { tryGetAuthContext } from "@/lib/auth/context";
import { getRecentWeeks, getNextMeeting, getLiveMeeting } from "@/lib/queries/me";
import { MeetingModeToggle } from "@/components/meeting-mode-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { TopBarNav } from "@/components/top-bar-nav";

type Role = "admin" | "member" | "viewer";

// Section index. `tiers` gates each item by the design role-tier mapping
// (owner→admin, leadership→member, frontline→viewer). Frontline gets the
// reduced set; Dashboard is leadership+ ; Readiness is owner-only.
const NAV: { href: string; label: string; tiers: Role[] }[] = [
  { href: "/", label: "Dashboard", tiers: ["admin", "member"] },
  { href: "/scorecard", label: "Scorecard", tiers: ["admin", "member", "viewer"] },
  { href: "/meeting", label: "Meeting", tiers: ["admin", "member", "viewer"] },
  { href: "/rocks", label: "Rocks", tiers: ["admin", "member"] },
  { href: "/todos", label: "To-Do's", tiers: ["admin", "member", "viewer"] },
  { href: "/issues", label: "Issues", tiers: ["admin", "member", "viewer"] },
  { href: "/admin/readiness", label: "Readiness", tiers: ["admin"] },
];

const TIER_LABEL: Record<Role, string> = {
  admin: "Owner",
  member: "Leadership",
  viewer: "Frontline",
};

function nextMeetingLabel(scheduledFor: Date): string {
  const days = Math.ceil((scheduledFor.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "in 1d";
  return `in ${days}d`;
}

/** The masthead. A two-tier newspaper nameplate:
 *    Tier 1: wordmark · edition · section index · LIVE · controls
 *    Tier 2: the dateline (week · quarter · next L10 · person/role)
 *  The dateline is hidden in meeting mode (chrome stripped). The only color
 *  anywhere in the shell is the red LIVE pill. */
export async function TopBar() {
  const ctx = await tryGetAuthContext();
  const role = (ctx?.role ?? "viewer") as Role;
  const items = ctx ? NAV.filter((n) => n.tiers.includes(role)) : [];

  const [weeks, nextMeeting, liveMeeting] = ctx
    ? await Promise.all([
        getRecentWeeks(1),
        getNextMeeting(ctx.orgId),
        getLiveMeeting(ctx.orgId),
      ])
    : [[], null, null];
  const currentWeek = weeks[0] ?? null;

  return (
    <SignedIn>
      <header className="sticky top-0 z-40 border-b border-border bg-surface-0/90 backdrop-blur supports-[backdrop-filter]:bg-surface-0/75">
        {/* Tier 1 — nameplate + section index + controls */}
        <div className="container flex h-14 items-center gap-5">
          <Link
            href="/"
            aria-label="TractionOS — Dashboard"
            className="focus-ring shrink-0 font-display text-[1.45rem] uppercase leading-none tracking-[0.01em] text-foreground"
          >
            TractionOS
          </Link>

          {ctx && (
            <OrganizationSwitcher
              hidePersonal
              appearance={{
                elements: {
                  rootBox: "shrink-0",
                  organizationSwitcherTrigger:
                    "rounded-[2px] border border-border bg-surface-1 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground hover:border-border-strong",
                },
              }}
            />
          )}

          <div className="min-w-0 flex-1 overflow-x-auto">
            <TopBarNav items={items} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            {liveMeeting && (
              <Link
                href="/meeting"
                title="A meeting is live"
                className="focus-ring flex items-center gap-1.5 rounded-[2px] border border-signal/40 bg-signal/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-signal"
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-signal animate-[pulse-status_2s_ease-in-out_infinite]"
                />
                Live
              </Link>
            )}
            <MeetingModeToggle className="hidden sm:flex" />
            <span className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:flex">
              Jerry
              <kbd className="rounded-[2px] border border-border bg-surface-1 px-1 py-px text-[9px] text-foreground">
                /
              </kbd>
            </span>
            <ThemeToggle />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </div>

        {/* Tier 2 — the dateline. Hidden in meeting mode. */}
        {ctx && (
          <div className="meeting-hide container flex h-7 items-center gap-3 border-t border-border/70 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span className="text-foreground/90">
              Week ending {currentWeek ? currentWeek.weekEndingDate : "—"}
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span>Q{currentWeek?.quarter ?? "—"}</span>
            {nextMeeting && (
              <>
                <span aria-hidden className="text-border">
                  ·
                </span>
                <span>Next L10 {nextMeetingLabel(nextMeeting.scheduledFor)}</span>
              </>
            )}
            <span className="ml-auto truncate text-muted-foreground/80">
              {ctx.personName} · {TIER_LABEL[role]}
            </span>
          </div>
        )}
      </header>
    </SignedIn>
  );
}
