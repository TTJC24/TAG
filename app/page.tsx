import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

/** Home → /me when an org is active; otherwise a tiny landing that prompts
 *  the user to pick one via the top-bar OrganizationSwitcher. */
export default async function HomePage() {
  const { orgId } = await auth();
  if (orgId) redirect("/me");

  return (
    <main className="container flex min-h-[60vh] flex-col items-center justify-center gap-4 py-12 text-center">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        tractionos
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Pick an organization to get started
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Use the organization switcher in the top bar (FS, BL, USA). Your view
        will load once an active org is selected.
      </p>
    </main>
  );
}
