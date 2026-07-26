import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GMAIL_COMPOSE_SCOPE,
  RsaEnvelopeCredentialDecryptor,
  RsaEnvelopeCredentialEncryptor,
  assertExactGmailCredentialScopes,
  redactSensitiveText,
} from "./index.js";

describe("connector credential boundary", () => {
  function keyPair() {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "der", type: "spki" },
      privateKeyEncoding: { format: "der", type: "pkcs8" },
    });
    return {
      encryptor: new RsaEnvelopeCredentialEncryptor(
        pair.publicKey.toString("base64"),
      ),
      decryptor: new RsaEnvelopeCredentialDecryptor(
        pair.privateKey.toString("base64"),
      ),
    };
  }

  it("round-trips only with the organization/version AAD and stores ciphertext", () => {
    const { encryptor, decryptor } = keyPair();
    const context = {
      organizationId: "10000000-0000-4000-8000-000000000001",
      credentialVersionId: "70000000-0000-4000-8000-000000000001",
    };
    const token = `sensitive-access-token-${"x".repeat(64)}`;
    const envelope = encryptor.encrypt(token, context);
    expect(JSON.stringify(envelope)).not.toContain(token);
    expect(decryptor.decrypt(envelope, context)).toBe(token);
    expect(() =>
      decryptor.decrypt(envelope, {
        ...context,
        organizationId: "10000000-0000-4000-8000-000000000002",
      }),
    ).toThrow();
  });

  it("pins the exact Gmail scope and redacts secrets from safe text", () => {
    expect(() =>
      assertExactGmailCredentialScopes([GMAIL_COMPOSE_SCOPE]),
    ).not.toThrow();
    expect(() =>
      assertExactGmailCredentialScopes([
        GMAIL_COMPOSE_SCOPE,
        "https://www.googleapis.com/auth/gmail.modify",
      ]),
    ).toThrow(/exactly/i);
    const token = "token-that-must-not-escape";
    expect(redactSensitiveText(`provider echoed ${token}`, [token])).toBe(
      "provider echoed [REDACTED]",
    );
  });
});
