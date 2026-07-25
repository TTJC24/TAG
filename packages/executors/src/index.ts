export interface ExecutionAction {
  organizationId: string;
  taskId: string;
  workflowId: string;
  approvalId: string;
  recommendationId: string;
  actionType: string;
  summary: string;
  payloadHash: string;
  payload?: unknown;
}

export interface ExecutionContext {
  traceId: string;
  requestId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface ExecutionProvider {
  readonly id: string;
  readonly kind: "internal" | "external";
  readonly enabled: boolean;
  execute(action: ExecutionAction, context: ExecutionContext): Promise<unknown>;
}

export interface ExternalExecutionProvider extends ExecutionProvider {
  readonly kind: "external";
}

export const GMAIL_COMPOSE_OAUTH_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_DRAFT_CAPABILITIES = ["drafts.create"] as const;

export interface GmailDraftPayload {
  capability: "drafts.create";
  previewId: string;
  authorizationId: string;
  to: string;
  subject: string;
  body: string;
  renderedPayloadHash: string;
  credentialSecretReference: string;
}

export interface GmailDraftCreateRequest {
  raw: string;
  credentialSecretReference: string;
}

export interface GmailDraftCreateResult {
  draftId: string;
  messageId: string;
  threadId: string | null;
}

export interface GmailDraftCreateTransport {
  createDraft(
    request: GmailDraftCreateRequest,
  ): Promise<GmailDraftCreateResult>;
}

export interface ConnectorSecretResolver {
  resolve(secretReference: string): Promise<string>;
}

export class EnvironmentConnectorSecretResolver implements ConnectorSecretResolver {
  async resolve(secretReference: string): Promise<string> {
    if (!secretReference.startsWith("env://")) {
      throw new Error("Only env:// connector secret references are supported");
    }
    const variableName = secretReference.slice("env://".length);
    if (!/^[A-Z][A-Z0-9_]{2,100}$/.test(variableName)) {
      throw new Error("Invalid connector secret environment reference");
    }
    const value = process.env[variableName];
    if (!value) {
      throw new Error("Connector secret reference could not be resolved");
    }
    return value;
  }
}

export class GoogleGmailDraftCreateTransport implements GmailDraftCreateTransport {
  constructor(private readonly secrets: ConnectorSecretResolver) {}

  async createDraft(
    request: GmailDraftCreateRequest,
  ): Promise<GmailDraftCreateResult> {
    const accessToken = await this.secrets.resolve(
      request.credentialSecretReference,
    );
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: { raw: request.raw } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Gmail drafts.create failed with HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as {
      id?: unknown;
      message?: { id?: unknown; threadId?: unknown };
    };
    if (
      typeof result.id !== "string" ||
      typeof result.message?.id !== "string"
    ) {
      throw new Error("Gmail drafts.create returned an invalid response");
    }
    return {
      draftId: result.id,
      messageId: result.message.id,
      threadId:
        typeof result.message.threadId === "string"
          ? result.message.threadId
          : null,
    };
  }
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function renderGmailDraftRaw(payload: {
  to: string;
  subject: string;
  body: string;
}): string {
  const mime = [
    `To: ${payload.to}`,
    `Subject: ${encodeSubject(payload.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    payload.body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseGmailDraftPayload(value: unknown): GmailDraftPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("capability" in value) ||
    value.capability !== "drafts.create" ||
    !("previewId" in value) ||
    typeof value.previewId !== "string" ||
    !("authorizationId" in value) ||
    typeof value.authorizationId !== "string" ||
    !("to" in value) ||
    typeof value.to !== "string" ||
    !("subject" in value) ||
    typeof value.subject !== "string" ||
    !("body" in value) ||
    typeof value.body !== "string" ||
    !("renderedPayloadHash" in value) ||
    typeof value.renderedPayloadHash !== "string" ||
    !("credentialSecretReference" in value) ||
    typeof value.credentialSecretReference !== "string"
  ) {
    throw new Error("Gmail draft execution payload is invalid");
  }
  return value as GmailDraftPayload;
}

export class GmailDraftExecutionProvider implements ExternalExecutionProvider {
  readonly id = "gmail-draft-v1";
  readonly kind = "external" as const;
  readonly enabled = true;
  readonly capabilities = GMAIL_DRAFT_CAPABILITIES;
  readonly oauthScopes = [GMAIL_COMPOSE_OAUTH_SCOPE] as const;

  constructor(private readonly transport: GmailDraftCreateTransport) {}

  async execute(
    action: ExecutionAction,
    _context: ExecutionContext,
  ): Promise<unknown> {
    const payload = parseGmailDraftPayload(action.payload);
    const result = await this.transport.createDraft({
      raw: renderGmailDraftRaw(payload),
      credentialSecretReference: payload.credentialSecretReference,
    });
    return {
      outcome: "succeeded",
      summary: "Created an authorized Gmail draft. No message was sent.",
      output: {
        capability: "drafts.create",
        draftId: result.draftId,
        messageId: result.messageId,
        threadId: result.threadId,
        draftLink: `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(
          result.draftId,
        )}`,
        renderedPayloadHash: payload.renderedPayloadHash,
      },
    };
  }
}

export class DisabledGmailDraftExecutionProvider implements ExternalExecutionProvider {
  readonly id = "gmail-draft-disabled";
  readonly kind = "external" as const;
  readonly enabled = false;
  readonly capabilities = GMAIL_DRAFT_CAPABILITIES;
  readonly oauthScopes = [GMAIL_COMPOSE_OAUTH_SCOPE] as const;

  async execute(
    _action: ExecutionAction,
    _context: ExecutionContext,
  ): Promise<never> {
    throw new Error("Gmail draft network execution is disabled");
  }
}

export interface DeterministicExecutionProviderOptions {
  outcome?: "succeeded" | "failed";
  failureCode?: string;
}

export class DeterministicInternalExecutionProvider implements ExecutionProvider {
  readonly id = "deterministic-internal-v1";
  readonly kind = "internal" as const;
  readonly enabled = true;

  constructor(
    private readonly options: DeterministicExecutionProviderOptions = {},
  ) {}

  async execute(
    action: ExecutionAction,
    context: ExecutionContext,
  ): Promise<unknown> {
    if (this.options.outcome === "failed") {
      return {
        outcome: "failed",
        summary: `Deterministic internal execution failed for ${action.actionType}.`,
        output: {
          actionType: action.actionType,
          commandId: context.commandId,
          failureCode:
            this.options.failureCode ?? "deterministic_execution_failure",
        },
      };
    }

    return {
      outcome: "succeeded",
      summary: `Recorded internal outcome for ${action.actionType}.`,
      output: {
        actionType: action.actionType,
        commandId: context.commandId,
        taskId: action.taskId,
        recommendationId: action.recommendationId,
        externalEffect: false,
      },
    };
  }
}

export class DisabledExternalExecutionProvider implements ExternalExecutionProvider {
  readonly id = "external-disabled";
  readonly kind = "external" as const;
  readonly enabled = false as const;

  async execute(
    _action: ExecutionAction,
    _context: ExecutionContext,
  ): Promise<never> {
    throw new Error("External execution providers are disabled");
  }
}

export function resolveExecutionProvider(
  configuredProvider = "deterministic_internal",
): ExecutionProvider {
  if (configuredProvider === "deterministic_internal") {
    return new DeterministicInternalExecutionProvider();
  }
  throw new Error(
    `Execution provider ${configuredProvider} is not enabled; only deterministic_internal is available`,
  );
}
