import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeterministicInternalExecutionProvider,
  DisabledGmailDraftExecutionProvider,
  DisabledExternalExecutionProvider,
  GmailDraftExecutionProvider,
  GoogleGmailDraftCreateTransport,
  GMAIL_COMPOSE_OAUTH_SCOPE,
  renderGmailDraftRaw,
  resolveExecutionProvider,
} from "./index.js";

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

  it("exposes only drafts.create and renders the exact authorized payload", async () => {
    const requests: Array<{ raw: string; credentialSecretReference: string }> =
      [];
    const provider = new GmailDraftExecutionProvider({
      async createDraft(request) {
        requests.push(request);
        return {
          draftId: "draft-123",
          messageId: "message-123",
          threadId: null,
        };
      },
    });
    const payload = {
      capability: "drafts.create" as const,
      previewId: "preview-1",
      authorizationId: "authorization-1",
      to: "customer@example.com",
      subject: "Approved follow-up",
      body: "Line one\nLine two",
      renderedPayloadHash: "b".repeat(64),
      credentialSecretReference: "env://GMAIL_TEST_TOKEN",
    };
    await expect(
      provider.execute({ ...action, payload }, context),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      output: {
        capability: "drafts.create",
        draftId: "draft-123",
        messageId: "message-123",
        renderedPayloadHash: payload.renderedPayloadHash,
      },
    });
    expect(provider.capabilities).toEqual(["drafts.create"]);
    expect(provider.oauthScopes).toEqual([GMAIL_COMPOSE_OAUTH_SCOPE]);
    expect(Object.keys(provider)).not.toContain("send");
    expect(requests).toEqual([
      {
        raw: renderGmailDraftRaw(payload),
        credentialSecretReference: "env://GMAIL_TEST_TOKEN",
      },
    ]);
    const decoded = Buffer.from(
      requests[0]!.raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain("To: customer@example.com\r\n");
    expect(decoded).toContain("Subject: Approved follow-up\r\n");
    expect(decoded).toContain("\r\n\r\nLine one\r\nLine two");
  });

  it("ships the Gmail draft provider network-disabled by default", async () => {
    const provider = new DisabledGmailDraftExecutionProvider();
    expect(provider.enabled).toBe(false);
    expect(provider.capabilities).toEqual(["drafts.create"]);
    await expect(provider.execute(action, context)).rejects.toThrow(
      /network execution is disabled/i,
    );
  });

  it("fixes the real transport to Gmail drafts.create and exposes no send request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "draft-fixed-1",
          message: { id: "message-fixed-1", threadId: "thread-fixed-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GoogleGmailDraftCreateTransport({
      async resolve(reference) {
        expect(reference).toBe("env://GMAIL_TEST_TOKEN");
        return "test-token-never-logged";
      },
    });
    await expect(
      transport.createDraft({
        raw: "base64url-message",
        credentialSecretReference: "env://GMAIL_TEST_TOKEN",
      }),
    ).resolves.toEqual({
      draftId: "draft-fixed-1",
      messageId: "message-fixed-1",
      threadId: "thread-fixed-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: { raw: "base64url-message" } }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("send");
  });
});
