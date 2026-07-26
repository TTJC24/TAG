import { describe, expect, it } from "vitest";
import {
  GmailDraftPilotOperator,
  type OperatorHttpRequest,
} from "./gmail-draft-pilot-client.js";

const organizationId = "10000000-0000-4000-8000-000000000003";

describe("GmailDraftPilotOperator", () => {
  it("kills any potentially committed credential when a downstream response is malformed", async () => {
    const requests: OperatorHttpRequest[] = [];
    const operator = new GmailDraftPilotOperator(async (request) => {
      requests.push(request);
      if (request.path.endsWith("/pilot/claim")) {
        const action = (request.body as { action: "claim" | "release" }).action;
        return {
          statusCode: 202,
          body: {
            organizationId,
            organizationCode: "USA",
            action: action === "claim" ? "claimed" : "released",
            claimVersion: action === "claim" ? 2 : 3,
            duplicate: false,
            traceId: "trace-fail-closed",
          },
        };
      }
      if (request.path.endsWith("/credentials")) {
        // Simulates an untrusted/malformed response after the API may have
        // committed the encrypted credential.
        return { statusCode: 202, body: {} };
      }
      if (request.path.endsWith("/config")) {
        return {
          statusCode: 202,
          body: {
            configVersionId: "90000000-0000-4000-8000-000000000001",
            organizationId,
            versionNumber: 2,
            bindingVersion: 2,
            enabled: false,
            allowedRecipientAddresses: [],
            allowedRecipientDomains: [],
            oauthScopes: ["https://www.googleapis.com/auth/gmail.compose"],
            reason: "Fail-closed cleanup: supervised pilot malformed response",
            duplicate: false,
            traceId: "trace-fail-closed",
          },
        };
      }
      throw new Error(`Unexpected operator request: ${request.path}`);
    });

    await expect(
      operator.enable({
        target: { organizationId, organizationCode: "USA" },
        recipient: "internal-test@company.example",
        accessToken: "mock-access-token-long-enough",
        reason: "supervised pilot malformed response",
        operationId: "operation-fail-closed",
        traceId: "trace-fail-closed",
      }),
    ).rejects.toThrow();

    expect(
      requests.map((request) => [
        request.path,
        (request.body as { action?: string; enabled?: boolean }).action ??
          (request.body as { enabled?: boolean }).enabled,
      ]),
    ).toEqual([
      ["/v1/connectors/gmail-draft/pilot/claim", "claim"],
      ["/v1/connectors/gmail-draft/credentials", undefined],
      ["/v1/connectors/gmail-draft/config", false],
      ["/v1/connectors/gmail-draft/pilot/claim", "release"],
    ]);
  });
});
