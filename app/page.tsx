import { auth } from "@clerk/nextjs/server";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

export default async function HomePage() {
  // The middleware enforces auth on `/`, so userId is non-null when we get
  // here. Reading orgSlug lets us prove org context is wired end-to-end.
  const { orgSlug } = await auth();

  return (
    <main className="container flex min-h-screen flex-col py-8">
      <header className="flex items-center justify-end gap-4 pb-12">
        <OrganizationSwitcher
          hidePersonal
          appearance={{ elements: { rootBox: "shrink-0" } }}
        />
        <UserButton afterSignOutUrl="/sign-in" />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          tractionos
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Phase 1 step 4 — Clerk wired
        </h1>
        <p className="font-mono text-sm text-muted-foreground tabular">
          active org: {orgSlug ?? "(none selected)"}
        </p>
      </section>
    </main>
  );
}
