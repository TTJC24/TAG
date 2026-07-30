import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EphemeralConnectorCredential,
  MAIL_COMPOSE_SCOPE,
  RsaEnvelopeCredentialDecryptor,
  RsaEnvelopeCredentialEncryptor,
  assertExactMailCredentialScopes,
  redactSensitiveText,
} from "./index.js";

describe("connector credential boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("rejects decryption with the wrong organization or an unrelated private key", () => {
    const { encryptor, decryptor } = keyPair();
    const unrelated = keyPair();
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
    expect(() => unrelated.decryptor.decrypt(envelope, context)).toThrow();
  });

  it("rejects a missing or malformed worker private key before runtime", () => {
    expect(() => new RsaEnvelopeCredentialDecryptor("")).toThrow(
      /private decryption key is required/i,
    );
    expect(
      () =>
        new RsaEnvelopeCredentialDecryptor(
          Buffer.from("not-a-private-key", "utf8").toString("base64"),
        ),
    ).toThrow();
  });

  it("rejects every scope set that is not exactly mail.compose", () => {
    expect(() =>
      assertExactMailCredentialScopes([
        MAIL_COMPOSE_SCOPE,
        "https://graph.microsoft.com/Mail.Send",
      ]),
    ).toThrow(/exactly/i);
    expect(() =>
      assertExactMailCredentialScopes([
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
      ]),
    ).toThrow(/exactly/i);
    expect(() => assertExactMailCredentialScopes([])).toThrow(/exactly/i);
  });

  it("redacts a credential object and an echoed token under structured logging duress", () => {
    const token = "token-that-must-not-escape";
    const credential = new EphemeralConnectorCredential(token);
    const captured: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      captured.push(
        values
          .map((value) =>
            typeof value === "string" ? value : inspect(value, { depth: 10 }),
          )
          .join(" "),
      );
    });

    console.error({
      name: "adversarial.credential.log",
      traceId: "trace-redaction-under-duress",
      credential,
      safeError: redactSensitiveText(`provider echoed ${credential.reveal()}`, [
        credential.reveal(),
      ]),
    });
    captured.push(JSON.stringify({ credential }));
    captured.push(String(credential));

    const completeOutput = captured.join("\n");
    expect(completeOutput).not.toContain(token);
    expect(completeOutput).toContain("[REDACTED]");
    expect(redactSensitiveText(`provider echoed ${token}`, [token])).toBe(
      "provider echoed [REDACTED]",
    );
    credential.dispose();
  });
});
