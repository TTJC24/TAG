import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Eyebrow, KeyHint } from "@/components/ui/primitives";

/** Home → /me when an org is active; otherwise a quiet console-login surface
 *  that points the user at the top-bar OrganizationSwitcher. Auth behavior
 *  (auth() → orgId → redirect) is preserved exactly. */
export default async function HomePage() {
  const { orgId } = await auth();
  if (orgId) redirect("/me");

  return (
    <main className="flex min-h-[calc(100vh-3rem)] items-center justify-center bg-surface-0 px-6 py-16">
      <section className="panel w-full max-w-md px-8 py-10 text-center">
        {/* Brand lockup — mono wordmark, semaphore dot mirroring the top bar. */}
        <div className="flex items-center justify-center gap-2">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-foreground/70"
          />
          <span className="font-mono text-sm uppercase tracking-[0.4em] text-foreground">
            tractionos
          </span>
        </div>

        <Eyebrow className="mt-6">select an organization</Eyebrow>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Use the organization switcher in the top bar to pick a workspace.
          Your L10 view loads as soon as an active org is selected.
        </p>

        <div className="mt-8 flex items-center justify-center gap-2 border-t border-border/60 pt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
          <span>top right</span>
          <KeyHint>FS</KeyHint>
          <KeyHint>BL</KeyHint>
          <KeyHint>USA</KeyHint>
        </div>
      </section>
    </main>
  );
}
