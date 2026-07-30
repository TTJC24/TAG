import type { EphemeralConnectorCredential } from "@operating-layer/connectors";

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
  connectorCredential?: EphemeralConnectorCredential;
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

/**
 * Microsoft Graph draft creation.
 *
 * Scope note, deliberately explicit: Graph has no compose-only permission. The
 * least privilege that can create a draft is Mail.ReadWrite, which also grants
 * mailbox read — that is inherent to Graph, not a choice made here.
 * `MAIL_SEND_OAUTH_SCOPE` is named only so the structural assertion below can
 * prove it is never requested; granting it would let this code send, which is
 * the one thing the whole approval architecture exists to prevent.
 */
export const MAIL_DRAFT_OAUTH_SCOPE =
  "https://graph.microsoft.com/Mail.ReadWrite";
/** Never requested. Named so the no-send assertion can check for its absence. */
export const MAIL_SEND_OAUTH_SCOPE = "https://graph.microsoft.com/Mail.Send";
export const MAIL_DRAFT_CAPABILITIES = ["drafts.create"] as const;

/**
 * Graph addresses a specific mailbox rather than an implicit current user,
 * which suits
 * this group: each entity has its own AR mailbox, so the destination comes from
 * that entity's connector config rather than being implied by a token.
 *
 * POST to a mailbox's /messages collection creates a DRAFT. Sending would be
 * /sendMail, which appears nowhere in this codebase.
 */
export const MAIL_DRAFT_ENDPOINT_TEMPLATE =
  "https://graph.microsoft.com/v1.0/users/{mailbox}/messages";

export function mailDraftEndpointFor(mailbox: string): string {
  return MAIL_DRAFT_ENDPOINT_TEMPLATE.replace(
    "{mailbox}",
    encodeURIComponent(mailbox),
  );
}

export interface MailDraftPayload {
  capability: "drafts.create";
  previewId: string;
  authorizationId: string;
  /** The mailbox the draft is created in (the entity's AR mailbox). */
  mailbox: string;
  to: string;
  subject: string;
  body: string;
  renderedPayloadHash: string;
}

export interface MailDraftCreateRequest {
  mailbox: string;
  to: string;
  subject: string;
  body: string;
  accessToken: string;
}

export interface MailDraftCreateResult {
  draftId: string;
  /** Graph's conversation grouping; the nearest analogue of a thread id. */
  conversationId: string | null;
  /** Deep link to the draft in Outlook, returned by Graph. */
  webLink: string | null;
}

export interface MailDraftCreateTransport {
  createDraft(request: MailDraftCreateRequest): Promise<MailDraftCreateResult>;
}

/**
 * Build the Graph message resource for a draft.
 *
 * Graph takes a structured JSON message, not base64 MIME, which removes a whole
 * class of header-injection risk: the subject and recipient are JSON values, so
 * a newline in either cannot forge a header the way it could in raw MIME. The
 * schema rejects newlines in the subject anyway — this is defence in depth.
 */
export function buildGraphDraftMessage(payload: {
  to: string;
  subject: string;
  body: string;
}): Record<string, unknown> {
  return {
    subject: payload.subject,
    body: { contentType: "Text", content: payload.body },
    toRecipients: [{ emailAddress: { address: payload.to } }],
  };
}

export class GraphMailDraftCreateTransport implements MailDraftCreateTransport {
  async createDraft(
    request: MailDraftCreateRequest,
  ): Promise<MailDraftCreateResult> {
    const response = await fetch(mailDraftEndpointFor(request.mailbox), {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildGraphDraftMessage(request)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `Microsoft Graph draft create failed with HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as {
      id?: unknown;
      isDraft?: unknown;
      conversationId?: unknown;
      webLink?: unknown;
    };
    if (typeof result.id !== "string") {
      throw new Error(
        "Microsoft Graph draft create returned an invalid response",
      );
    }
    // Read-back safety check: Graph states outright
    // whether the message it created is a draft. If it is not, something has
    // gone very wrong — refuse to report success.
    if (result.isDraft !== true) {
      throw new Error(
        "Microsoft Graph returned a message that is not a draft; refusing to report success",
      );
    }
    return {
      draftId: result.id,
      conversationId:
        typeof result.conversationId === "string"
          ? result.conversationId
          : null,
      webLink: typeof result.webLink === "string" ? result.webLink : null,
    };
  }
}

function parseMailDraftPayload(value: unknown): MailDraftPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("capability" in value) ||
    value.capability !== "drafts.create" ||
    !("previewId" in value) ||
    typeof value.previewId !== "string" ||
    !("authorizationId" in value) ||
    typeof value.authorizationId !== "string" ||
    !("mailbox" in value) ||
    typeof value.mailbox !== "string" ||
    value.mailbox.length === 0 ||
    !("to" in value) ||
    typeof value.to !== "string" ||
    !("subject" in value) ||
    typeof value.subject !== "string" ||
    !("body" in value) ||
    typeof value.body !== "string" ||
    !("renderedPayloadHash" in value) ||
    typeof value.renderedPayloadHash !== "string"
  ) {
    throw new Error("Outlook draft execution payload is invalid");
  }
  return value as MailDraftPayload;
}

export class MailDraftExecutionProvider implements ExternalExecutionProvider {
  readonly id = "mail-draft-v1";
  readonly kind = "external" as const;
  readonly enabled = true;
  readonly capabilities = MAIL_DRAFT_CAPABILITIES;
  readonly oauthScopes = [MAIL_DRAFT_OAUTH_SCOPE] as const;

  constructor(private readonly transport: MailDraftCreateTransport) {}

  async execute(
    action: ExecutionAction,
    context: ExecutionContext,
  ): Promise<unknown> {
    const payload = parseMailDraftPayload(action.payload);
    const credential = context.connectorCredential;
    if (!credential) {
      throw new Error("Execution-time connector credential is required");
    }
    const result = await this.transport.createDraft({
      mailbox: payload.mailbox,
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      accessToken: credential.reveal(),
    });
    return {
      outcome: "succeeded",
      summary: "Created an authorized Outlook draft. No message was sent.",
      output: {
        capability: "drafts.create",
        draftId: result.draftId,
        conversationId: result.conversationId,
        // Graph hands back its own deep link; never construct one, so a link
        // that appears in the audit trail is one the provider vouched for.
        draftLink: result.webLink,
        mailbox: payload.mailbox,
        renderedPayloadHash: payload.renderedPayloadHash,
      },
    };
  }
}

export class DisabledMailDraftExecutionProvider implements ExternalExecutionProvider {
  readonly id = "mail-draft-disabled";
  readonly kind = "external" as const;
  readonly enabled = false;
  readonly capabilities = MAIL_DRAFT_CAPABILITIES;
  readonly oauthScopes = [MAIL_DRAFT_OAUTH_SCOPE] as const;

  async execute(
    _action: ExecutionAction,
    _context: ExecutionContext,
  ): Promise<never> {
    throw new Error("Outlook draft network execution is disabled");
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

/**
 * Prove structurally — not by assertion in a comment — that this code cannot
 * send mail.
 *
 * Microsoft Graph separates drafting from sending in two independent ways, and
 * this checks both:
 *
 * - by path: a mailbox's /messages collection creates a draft; /sendMail sends.
 * - by permission: Mail.ReadWrite can draft, Mail.Send can send.
 *
 * Proving Mail.Send is absent from the requested scopes is the stronger of the
 * two: without that permission the token cannot send even if some future
 * endpoint slipped into the code.
 */
export function inspectMailDraftStructuralSafety(): {
  capabilities: readonly ["drafts.create"];
  oauthScopes: readonly [typeof MAIL_DRAFT_OAUTH_SCOPE];
  endpoint: typeof MAIL_DRAFT_ENDPOINT_TEMPLATE;
  hasSendSurface: boolean;
  requestsSendScope: boolean;
  structuralNoSend: boolean;
} {
  const providerMethods = Object.getOwnPropertyNames(
    MailDraftExecutionProvider.prototype,
  );
  const transportMethods = Object.getOwnPropertyNames(
    GraphMailDraftCreateTransport.prototype,
  );
  const scopes: readonly string[] = [MAIL_DRAFT_OAUTH_SCOPE];
  const requestsSendScope = scopes.some((scope) =>
    scope.toLowerCase().includes("mail.send"),
  );
  const hasSendSurface =
    providerMethods.some((name) => /send/i.test(name)) ||
    transportMethods.some((name) => /send/i.test(name)) ||
    /sendmail|\/send\b/i.test(MAIL_DRAFT_ENDPOINT_TEMPLATE);
  return {
    capabilities: MAIL_DRAFT_CAPABILITIES,
    oauthScopes: [MAIL_DRAFT_OAUTH_SCOPE],
    endpoint: MAIL_DRAFT_ENDPOINT_TEMPLATE,
    hasSendSurface,
    requestsSendScope,
    structuralNoSend:
      MAIL_DRAFT_CAPABILITIES.length === 1 &&
      MAIL_DRAFT_CAPABILITIES[0] === "drafts.create" &&
      // A mailbox's /messages collection creates drafts; /sendMail sends.
      MAIL_DRAFT_ENDPOINT_TEMPLATE.endsWith("/messages") &&
      !hasSendSurface &&
      !requestsSendScope,
  };
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
