import { headers } from "next/headers";

/**
 * Identity headers the web tier forwards to the API. In production behind
 * Cloudflare Access, the edge injects cf-access-authenticated-user-email on
 * every request and we pass it through per-request. In local development the
 * DEV_USER_EMAIL fallback keeps the existing single-user flow working.
 */
export async function identityHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const cloudflareEmail = incoming.get("cf-access-authenticated-user-email");
  if (cloudflareEmail) {
    return { "cf-access-authenticated-user-email": cloudflareEmail };
  }
  const developmentEmail =
    process.env.DEV_USER_EMAIL ?? "executive@local.operating-layer";
  return { "x-dev-user-email": developmentEmail };
}
