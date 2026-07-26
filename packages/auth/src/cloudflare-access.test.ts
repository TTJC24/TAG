import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CloudflareAccessIdentityProvider,
} from "./index.js";

describe("CloudflareAccessIdentityProvider", () => {
  const provider = new CloudflareAccessIdentityProvider();

  it("authenticates from the Cloudflare Access header", async () => {
    const identity = await provider.authenticate({
      headers: { "cf-access-authenticated-user-email": "Tim@Example.com " },
    });
    expect(identity).toEqual({
      issuer: "cloudflare-access",
      subject: "tim@example.com",
      email: "tim@example.com",
    });
  });

  it("rejects requests without the header — no anonymous access", async () => {
    await expect(provider.authenticate({ headers: {} })).rejects.toThrow(
      AuthenticationError,
    );
    await expect(
      provider.authenticate({
        headers: { "cf-access-authenticated-user-email": "  " },
      }),
    ).rejects.toThrow(AuthenticationError);
  });
});
