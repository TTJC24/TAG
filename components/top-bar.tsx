import Link from "next/link";
import { OrganizationSwitcher, UserButton, SignedIn } from "@clerk/nextjs";
import { tryGetAuthContext } from "@/lib/auth/context";

const NAV: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/me", label: "Me" },
  { href: "/scorecard", label: "Scorecard" },
  { href: "/admin/readiness", label: "Readiness", adminOnly: true },
];

/** Top navigation rendered on every authenticated page. Server component so
 *  the role check can gate the admin link without shipping it to the client. */
export async function TopBar() {
  const ctx = await tryGetAuthContext();
  const items = NAV.filter((n) => !n.adminOnly || ctx?.role === "admin");

  return (
    <SignedIn>
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="container flex h-12 items-center gap-4">
          <Link
            href="/me"
            className="font-mono text-xs uppercase tracking-widest text-foreground"
          >
            tractionos
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-muted-foreground transition hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <OrganizationSwitcher
              hidePersonal
              appearance={{ elements: { rootBox: "shrink-0" } }}
            />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </div>
      </header>
    </SignedIn>
  );
}
