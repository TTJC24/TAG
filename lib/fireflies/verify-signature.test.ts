import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyFirefliesSignature } from "./verify-signature";

const SECRET = "test-secret";
const BODY = JSON.stringify({ meetingId: "m_123", eventType: "Transcription completed" });
const VALID = createHmac("sha256", SECRET).update(BODY).digest("hex");

describe("verifyFirefliesSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyFirefliesSignature(BODY, VALID, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = BODY.replace("m_123", "m_999");
    expect(verifyFirefliesSignature(tampered, VALID, SECRET)).toBe(false);
  });

  it("rejects a bad signature of the right length", () => {
    const wrong = VALID.slice(0, -1) + (VALID.endsWith("0") ? "1" : "0");
    expect(verifyFirefliesSignature(BODY, wrong, SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(verifyFirefliesSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyFirefliesSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyFirefliesSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects a length-mismatched signature without throwing", () => {
    expect(verifyFirefliesSignature(BODY, "abc", SECRET)).toBe(false);
  });

  it("rejects when computed with the wrong secret", () => {
    const wrongSig = createHmac("sha256", "other-secret").update(BODY).digest("hex");
    expect(verifyFirefliesSignature(BODY, wrongSig, SECRET)).toBe(false);
  });
});
