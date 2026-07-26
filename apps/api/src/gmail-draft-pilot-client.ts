import { createHash, randomUUID } from "node:crypto";
import {
  gmailCredentialResponseSchema,
  gmailDraftConnectorConfigResponseSchema,
  gmailDraftPilotClaimResponseSchema,
  gmailDraftPilotPreflightResponseSchema,
  type GmailCredentialResponse,
  type GmailDraftConnectorConfigResponse,
  type GmailDraftPilotClaimResponse,
  type GmailDraftPilotPreflightResponse,
} from "@operating-layer/schemas";

export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose" as const;

export interface OperatorHttpRequest {
  method: "POST";
  path: string;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export interface OperatorHttpResponse {
  statusCode: number;
  body: unknown;
}

export type OperatorHttpClient = (
  request: OperatorHttpRequest,
) => Promise<OperatorHttpResponse>;

export interface GmailDraftPilotTarget {
  organizationId: string;
  organizationCode: string;
}

export function gmailCredentialFingerprint(accessToken: string): string {
  return createHash("sha256").update(accessToken, "utf8").digest("hex");
}

function safeApiError(response: OperatorHttpResponse): Error {
  const body =
    typeof response.body === "object" && response.body !== null
      ? (response.body as { error?: unknown; message?: unknown })
      : {};
  const code = typeof body.error === "string" ? body.error : "api_error";
  const message =
    typeof body.message === "string"
      ? body.message
      : `Operator API request failed with HTTP ${response.statusCode}`;
  return new Error(`${code}: ${message}`);
}

async function expectSuccess(
  request: OperatorHttpClient,
  input: OperatorHttpRequest,
): Promise<unknown> {
  const response = await request(input);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw safeApiError(response);
  }
  return response.body;
}

function commandHeaders(
  operationId: string,
  suffix: string,
  traceId: string,
): Record<string, string> {
  return {
    "idempotency-key": `${operationId}:${suffix}`,
    "x-trace-id": traceId,
  };
}

export class GmailDraftPilotOperator {
  constructor(private readonly request: OperatorHttpClient) {}

  async preflight(input: {
    target: GmailDraftPilotTarget;
    expectedRecipient?: string;
    expectedCredentialFingerprint?: string;
    traceId?: string;
  }): Promise<GmailDraftPilotPreflightResponse> {
    const response = await expectSuccess(this.request, {
      method: "POST",
      path: "/v1/connectors/gmail-draft/pilot/preflight",
      headers: { "x-trace-id": input.traceId ?? randomUUID() },
      body: {
        organizationId: input.target.organizationId,
        expectedOrganizationCode: input.target.organizationCode,
        ...(input.expectedRecipient
          ? { expectedRecipient: input.expectedRecipient }
          : {}),
        ...(input.expectedCredentialFingerprint
          ? {
              expectedCredentialFingerprint:
                input.expectedCredentialFingerprint,
            }
          : {}),
      },
    });
    return gmailDraftPilotPreflightResponseSchema.parse(response);
  }

  private async setClaim(input: {
    target: GmailDraftPilotTarget;
    action: "claim" | "release";
    reason: string;
    operationId: string;
    traceId: string;
  }): Promise<GmailDraftPilotClaimResponse> {
    const response = await expectSuccess(this.request, {
      method: "POST",
      path: "/v1/connectors/gmail-draft/pilot/claim",
      headers: commandHeaders(
        input.operationId,
        `pilot-${input.action}`,
        input.traceId,
      ),
      body: {
        organizationId: input.target.organizationId,
        action: input.action,
        reason: input.reason,
      },
    });
    const parsed = gmailDraftPilotClaimResponseSchema.parse(response);
    if (
      parsed.organizationCode.toUpperCase() !==
      input.target.organizationCode.toUpperCase()
    ) {
      throw new Error("Pilot claim returned an unexpected organization code");
    }
    return parsed;
  }

  private async disableConfiguration(input: {
    target: GmailDraftPilotTarget;
    reason: string;
    operationId: string;
    traceId: string;
    suffix: string;
  }): Promise<GmailDraftConnectorConfigResponse> {
    const response = await expectSuccess(this.request, {
      method: "POST",
      path: "/v1/connectors/gmail-draft/config",
      headers: commandHeaders(input.operationId, input.suffix, input.traceId),
      body: {
        organizationId: input.target.organizationId,
        enabled: false,
        allowedRecipientAddresses: [],
        allowedRecipientDomains: [],
        reason: input.reason,
      },
    });
    return gmailDraftConnectorConfigResponseSchema.parse(response);
  }

  async enable(input: {
    target: GmailDraftPilotTarget;
    recipient: string;
    accessToken: string;
    reason: string;
    operationId?: string;
    traceId?: string;
  }): Promise<{
    operationId: string;
    traceId: string;
    claim: GmailDraftPilotClaimResponse;
    credential: GmailCredentialResponse;
    configuration: GmailDraftConnectorConfigResponse;
    preflight: GmailDraftPilotPreflightResponse;
  }> {
    const operationId = input.operationId ?? randomUUID();
    const traceId = input.traceId ?? randomUUID();
    const fingerprint = gmailCredentialFingerprint(input.accessToken);
    let claim: GmailDraftPilotClaimResponse | undefined;
    let credential: GmailCredentialResponse | undefined;
    let configuration: GmailDraftConnectorConfigResponse | undefined;
    try {
      claim = await this.setClaim({
        target: input.target,
        action: "claim",
        reason: input.reason,
        operationId,
        traceId,
      });
      const credentialResponse = await expectSuccess(this.request, {
        method: "POST",
        path: "/v1/connectors/gmail-draft/credentials",
        headers: commandHeaders(operationId, "credential-store", traceId),
        body: {
          organizationId: input.target.organizationId,
          accessToken: input.accessToken,
          grantedScopes: [GMAIL_COMPOSE_SCOPE],
          reason: input.reason,
        },
      });
      credential = gmailCredentialResponseSchema.parse(credentialResponse);
      const configurationResponse = await expectSuccess(this.request, {
        method: "POST",
        path: "/v1/connectors/gmail-draft/config",
        headers: commandHeaders(operationId, "config-enable", traceId),
        body: {
          organizationId: input.target.organizationId,
          enabled: true,
          allowedRecipientAddresses: [input.recipient],
          allowedRecipientDomains: [],
          reason: input.reason,
        },
      });
      configuration = gmailDraftConnectorConfigResponseSchema.parse(
        configurationResponse,
      );
      const preflight = await this.preflight({
        target: input.target,
        expectedRecipient: input.recipient,
        expectedCredentialFingerprint: fingerprint,
        traceId,
      });
      if (!preflight.readyForLiveDraft) {
        throw new Error(
          "Gmail draft live-pilot preflight did not pass every check",
        );
      }
      return {
        operationId,
        traceId,
        claim,
        credential,
        configuration,
        preflight,
      };
    } catch (error) {
      // Once the claim succeeds, a downstream response can be malformed after
      // the server has already committed a credential or configuration. Always
      // invoke the credential-killing disable path rather than relying on the
      // client-side parse result to decide whether cleanup is necessary.
      if (claim) {
        try {
          await this.disableConfiguration({
            target: input.target,
            reason: `Fail-closed cleanup: ${input.reason}`,
            operationId,
            traceId,
            suffix: "cleanup-disable",
          });
        } catch {
          try {
            await expectSuccess(this.request, {
              method: "POST",
              path: "/v1/connectors/gmail-draft/credentials/revoke",
              headers: commandHeaders(operationId, "cleanup-revoke", traceId),
              body: {
                organizationId: input.target.organizationId,
                reason: `Fail-closed cleanup: ${input.reason}`,
              },
            });
          } catch {
            throw new AggregateError(
              [error],
              "Pilot enable failed and automatic credential cleanup failed; invoke the disable command immediately",
            );
          }
        }
      }
      if (claim) {
        try {
          await this.setClaim({
            target: input.target,
            action: "release",
            reason: `Fail-closed cleanup: ${input.reason}`,
            operationId,
            traceId,
          });
        } catch {
          throw new AggregateError(
            [error],
            "Pilot enable failed and automatic claim release failed; invoke the disable command immediately",
          );
        }
      }
      throw error;
    }
  }

  async disable(input: {
    target: GmailDraftPilotTarget;
    reason: string;
    operationId?: string;
    traceId?: string;
  }): Promise<{
    operationId: string;
    traceId: string;
    configuration: GmailDraftConnectorConfigResponse;
    claim: GmailDraftPilotClaimResponse;
    preflight: GmailDraftPilotPreflightResponse;
  }> {
    const operationId = input.operationId ?? randomUUID();
    const traceId = input.traceId ?? randomUUID();
    const configuration = await this.disableConfiguration({
      target: input.target,
      reason: input.reason,
      operationId,
      traceId,
      suffix: "config-disable",
    });
    const claim = await this.setClaim({
      target: input.target,
      action: "release",
      reason: input.reason,
      operationId,
      traceId,
    });
    const preflight = await this.preflight({
      target: input.target,
      traceId,
    });
    if (!preflight.disabledByDefault) {
      throw new Error(
        "Gmail draft pilot teardown did not restore disabled-by-default posture",
      );
    }
    return { operationId, traceId, configuration, claim, preflight };
  }
}

export function createFetchOperatorHttpClient(input: {
  apiBaseUrl: string;
  bearerToken?: string;
  developmentUserEmail?: string;
}): OperatorHttpClient {
  if (!input.bearerToken && !input.developmentUserEmail) {
    throw new Error(
      "Operator authentication requires a bearer token or development user email",
    );
  }
  const apiBaseUrl = input.apiBaseUrl.replace(/\/+$/, "");
  return async (request) => {
    const response = await fetch(`${apiBaseUrl}${request.path}`, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        ...(input.bearerToken
          ? { authorization: `Bearer ${input.bearerToken}` }
          : {}),
        ...(input.developmentUserEmail
          ? { "x-dev-user-email": input.developmentUserEmail }
          : {}),
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      statusCode: response.status,
      body: (await response.json()) as unknown,
    };
  };
}
