export default function HomePage() {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center gap-6 py-16">
      <div className="space-y-2 text-center">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          tractionos
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          L10 meeting platform — Phase 1 scaffold
        </h1>
        <p className="text-sm text-muted-foreground">
          Three independent orgs. Real-time. Voice + transcript driven.
        </p>
      </div>
      <div className="font-mono text-xs text-muted-foreground tabular">
        <div>FS &middot; BL &middot; USA</div>
      </div>
    </main>
  );
}
