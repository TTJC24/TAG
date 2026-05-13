// Fireflies webhook signature verification.
//
// Fireflies signs each webhook delivery with an HMAC-SHA256 of the raw body
// using the workspace's webhook secret. The signature is hex-encoded and
// arrives in the `x-fireflies-signature` header.
//
// We always do a constant-time compare to avoid leaking timing information.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyFirefliesSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Both strings must be the same length for timingSafeEqual.
  if (expected.length !== signatureHeader.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signatureHeader, "utf8"),
    );
  } catch {
    return false;
  }
}
