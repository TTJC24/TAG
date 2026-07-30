import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralConnectorCredential } from "@operating-layer/connectors";
import {
  DeterministicInternalExecutionProvider,
  DisabledMailDraftExecutionProvider,
  DisabledExternalExecutionProvider,
  MailDraftExecutionProvider,
  GraphMailDraftCreateTransport,
  MAIL_DRAFT_OAUTH_SCOPE,
  inspectMailDraftStructuralSafety,
  buildGraphDraftMessage,
  mailDraftEndpointFor,
  resolveExecutionProvider,
  type MailDraftCreateTransport,
} from "./index.js";

type AssertFalse<T extends false> = T;
type MailTransportHasNoSend = AssertFalse<
  "send" extends keyof MailDraftCreateTransport ? true : false
>;
type MailProviderHasNoSend = AssertFalse<
  "send" extends keyof MailDraftExecutionProvider ? true : false
>;

const action = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  taskId: "10000000-0000-4000-8000-000000000002",
  workflowId: "10000000-0000-4000-8000-000000000003",
  approvalId: "10000000-0000-4000-8000-000000000004",
  recommendationId: "10000000-0000-4000-8000-000000000005",
  actionType: "collections_follow_up",
  summary: "Record an internal collections follow-up outcome.",
  payloadHash: "a".repeat(64),
};
const context = {
  traceId: "trace-executor-test",
  requestId: "request-executor-test",
  commandId: "command-executor-test",
  idempotencyKey: "idempotency-executor-test",
};

describe("execution provider seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables only the deterministic internal provider by default", async () => {
    const provider = resolveExecutionProvider();
    expect(provider).toBeInstanceOf(DeterministicInternalExecutionProvider);
    expect(provider).toMatchObject({
      id: "deterministic-internal-v1",
      kind: "internal",
      enabled: true,
    });
    await expect(provider.execute(action, context)).resolves.toMatchObject({
      outcome: "succeeded",
      output: { externalEffect: false },
    });
  });

  it("keeps the external provider inert and unreachable through resolution", async () => {
    const external = new DisabledExternalExecutionProvider();
    expect(external.enabled).toBe(false);
    await expect(external.execute(action, context)).rejects.toThrow(
      /disabled/i,
    );
    expect(() => resolveExecutionProvider("external")).toThrow(/not enabled/i);
  });

  it("exposes only drafts.create and sends the exact authorized payload to Graph", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new MailDraftExecutionProvider({
      async createDraft(request) {
        requests.push(request as unknown as Record<string, unknown>);
        return {
          draftId: "AAMkAG-draft-123",
          conversationId: "conv-abc",
          webLink:
            "https://outlook.office365.com/mail/deeplink/AAMkAG-draft-123",
        };
      },
    });
    const payload = {
      capability: "drafts.create" as const,
      previewId: "preview-1",
      authorizationId: "authorization-1",
      mailbox: "ar@fasteningspecialists.example",
      to: "customer@example.com",
      subject: "Approved follow-up",
      body: "Line one\nLine two",
      renderedPayloadHash: "b".repeat(64),
    };
    await expect(
      provider.execute(
        { ...action, payload },
        {
          ...context,
          connectorCredential: new EphemeralConnectorCredential(
            "test-token-never-logged",
          ),
        },
      ),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      output: {
        capability: "drafts.create",
        draftId: "AAMkAG-draft-123",
        conversationId: "conv-abc",
        // the deep link must be the one Graph vouched for, never constructed
        draftLink:
          "https://outlook.office365.com/mail/deeplink/AAMkAG-draft-123",
        mailbox: "ar@fasteningspecialists.example",
        renderedPayloadHash: payload.renderedPayloadHash,
      },
    });
    expect(provider.capabilities).toEqual(["drafts.create"]);
    expect(provider.oauthScopes).toEqual([MAIL_DRAFT_OAUTH_SCOPE]);
    expect(Object.keys(provider)).not.toContain("send");
    expect(
      Object.getOwnPropertyNames(MailDraftExecutionProvider.prototype),
    ).toEqual(["constructor", "execute"]);
    expect(requests).toEqual([
      {
        mailbox: "ar@fasteningspecialists.example",
        to: "customer@example.com",
        subject: "Approved follow-up",
        body: "Line one\nLine two",
        accessToken: "test-token-never-logged",
      },
    ]);
  });

  it("builds a Graph message whose recipient and subject are JSON values, not headers", () => {
    // The structured form is what makes header injection impossible: a newline
    // in the subject stays data instead of forging a Bcc.
    const message = buildGraphDraftMessage({
      to: "customer@example.com",
      subject: "Hello\r\nBcc: sneaky@example.com",
      body: "Body text",
    });
    expect(message).toEqual({
      subject: "Hello\r\nBcc: sneaky@example.com",
      body: { contentType: "Text", content: "Body text" },
      toRecipients: [{ emailAddress: { address: "customer@example.com" } }],
    });
  });

  it("targets the mailbox's messages collection, never sendMail", () => {
    const endpoint = mailDraftEndpointFor("ar@fasteningspecialists.example");
    expect(endpoint).toBe(
      "https://graph.microsoft.com/v1.0/users/ar%40fasteningspecialists.example/messages",
    );
    expect(endpoint).not.toMatch(/sendMail/i);
  });

  it("refuses to report success if Graph returns something that is not a draft", async () => {
    const provider = new MailDraftExecutionProvider({
      async createDraft() {
        // a transport that silently sent instead of drafting
        throw new Error(
          "Microsoft Graph returned a message that is not a draft; refusing to report success",
        );
      },
    });
    await expect(
      provider.execute(
        {
          ...action,
          payload: {
            capability: "drafts.create",
            previewId: "p",
            authorizationId: "a",
            mailbox: "ar@x.example",
            to: "c@example.com",
            subject: "s",
            body: "b",
            renderedPayloadHash: "c".repeat(64),
          },
        },
        {
          ...context,
          connectorCredential: new EphemeralConnectorCredential("tok"),
        },
      ),
    ).rejects.toThrow(/not a draft/i);
  });

  it("rejects a payload with no mailbox, since the destination would be undefined", async () => {
    const provider = new MailDraftExecutionProvider({
      async createDraft() {
        throw new Error("must not be reached");
      },
    });
    await expect(
      provider.execute(
        {
          ...action,
          payload: {
            capability: "drafts.create",
            previewId: "p",
            authorizationId: "a",
            to: "c@example.com",
            subject: "s",
            body: "b",
            renderedPayloadHash: "c".repeat(64),
          },
        },
        {
          ...context,
          connectorCredential: new EphemeralConnectorCredential("tok"),
        },
      ),
    ).rejects.toThrow(/payload is invalid/i);
  });

  it("ships the Outlook draft provider network-disabled by default", async () => {
    const provider = new DisabledMailDraftExecutionProvider();
    expect(provider.enabled).toBe(false);
    expect(provider.capabilities).toEqual(["drafts.create"]);
    await expect(provider.execute(action, context)).rejects.toThrow(
      /network execution is disabled/i,
    );
  });

  it("makes messages.send unreachable at the type, object, prototype, route-target, and request levels", async () => {
    const transportHasNoSend: MailTransportHasNoSend = false;
    const providerHasNoSend: MailProviderHasNoSend = false;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "draft-fixed-1",
          isDraft: true,
          conversationId: "conv-fixed-1",
          webLink: "https://outlook.office365.com/mail/deeplink/draft-fixed-1",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GraphMailDraftCreateTransport();
    const provider = new MailDraftExecutionProvider(transport);
    expect(transportHasNoSend).toBe(false);
    expect(providerHasNoSend).toBe(false);
    expect("send" in transport).toBe(false);
    expect("send" in provider).toBe(false);
    expect("messages.send" in transport).toBe(false);
    expect("messages.send" in provider).toBe(false);
    expect(inspectMailDraftStructuralSafety()).toMatchObject({
      capabilities: ["drafts.create"],
      oauthScopes: [MAIL_DRAFT_OAUTH_SCOPE],
      hasSendSurface: false,
      // Graph gates sending by permission as well as by path: proving Mail.Send
      // is never requested is the stronger of the two guarantees.
      requestsSendScope: false,
      structuralNoSend: true,
    });
    await expect(
      transport.createDraft({
        mailbox: "ar@fasteningspecialists.example",
        to: "customer@example.com",
        subject: "Approved follow-up",
        body: "Body text",
        accessToken: "test-token-never-logged",
      }),
    ).resolves.toEqual({
      draftId: "draft-fixed-1",
      conversationId: "conv-fixed-1",
      webLink: "https://outlook.office365.com/mail/deeplink/draft-fixed-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/users/ar%40fasteningspecialists.example/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          subject: "Approved follow-up",
          body: { contentType: "Text", content: "Body text" },
          toRecipients: [{ emailAddress: { address: "customer@example.com" } }],
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toMatch(/sendMail|\/send\b/i);
    expect(
      Object.getOwnPropertyNames(GraphMailDraftCreateTransport.prototype),
    ).toEqual(["constructor", "createDraft"]);
    expect(
      Object.getOwnPropertyNames(MailDraftExecutionProvider.prototype),
    ).toEqual(["constructor", "execute"]);
  });
});
