import { SignIn } from "@clerk/nextjs";
import { Eyebrow } from "@/components/ui/primitives";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-0 px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        {/* Brand lockup — console-login header above the Clerk widget. */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-foreground/70"
            />
            <span className="font-mono text-sm uppercase tracking-[0.4em] text-foreground">
              tractionos
            </span>
          </div>
          <Eyebrow>sign in</Eyebrow>
        </div>
        <SignIn />
      </div>
    </main>
  );
}
