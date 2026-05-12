// Server-side env access with explicit names.
//
// We don't pull in zod here in Phase 1 — keep the surface small. Each external
// integration (Clerk, Liveblocks, Resend, Graph, Fireflies, Google AI Studio,
// Groq) will add its own helper that throws a useful error if the value is
// missing at runtime. The full required-vs-optional list lives in
// .env.example.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. Check .env.example and your .env.local file.`,
    );
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
