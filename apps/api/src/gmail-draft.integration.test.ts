import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@operating-layer/audit";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  withOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import {
  DeterministicInternalExecutionProvider,
  GmailDraftExecutionProvider,
  GMAIL_COMPOSE_OAUTH_SCOPE,
  GMAIL_DRAFT_CAPABILITIES,
  type GmailDraftCreateTransport,
} from "@operating-layer/executors";
import {
  drainOutbox,
  processNextOutboxJob,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const usaId = "10000000-0000-4000-8000-000000000003";
const fsiId = "10000000-0000-4000-8000-000000000002";
const fsiOperatorId = "20000000-0000-4000-8000-000000000004";
const executiveId = "20000000-0000-4000-8000-000000000002";
const adminEmail = "admin@local.operating-layer";
const executiveEmail = "executive@local.operating-layer";
const approverEmail = "approver@local.operating-layer";

interface ApprovedTask {
  taskId: string;
  workflowId: string;
  approvalId: string;
  traceId: string;
}

describe("Phase 3 Gmail draft external-write slice", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  const internalProvider = new DeterministicInternalExecutionProvider();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!databaseUrl || !runtimeDatabaseUrl) {
      throw new Error("Feature-test database URLs are required");
    }
    adminPool = createDatabasePool(databaseUrl);
    pool = createDatabasePool(runtimeDatabaseUrl);
    await assertSafeRuntimeDatabaseIdentity(pool);
    app = await buildApi({
      pool,
      identityProvider: new DevelopmentHeaderIdentityProvider(),
      logger: false,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await adminPool.end();
  });

  async function createApprovedTask(label: string): Promise<ApprovedTask> {
    const traceId = `trace-gmail-${label}-${randomUUID()}`;
    const intake = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": executiveEmail,
        "idempotency-key": `gmail-intake-${label}-${randomUUID()}`,
        "x-trace-id": traceId,
      },
      payload: {
        organizationId: usaId,
        title: `${label}: customer follow-up draft`,
        description:
          "Prepare a customer email draft for review. Do not send it.",
        financialExposure: 75_000,
        financialExposureCurrency: "USD",
        retentionClassification: "operational",
      },
    });
    expect(intake.statusCode, intake.body).toBe(202);
    const intakeBody = intake.json<{ taskId: string; workflowId: string }>();
    const drained = await drainOutbox(
      pool,
      `gmail-setup-${label}`,
      20,
      internalProvider,
    );
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${intakeBody.taskId}?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const approvalId = detail.json<{
      approvals: Array<{ id: string; status: string }>;
    }>().approvals[0]?.id;
    expect(approvalId).toBeTruthy();

    const resolution = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolution`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `gmail-approve-${label}-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        decision: "approved",
        reason: "Cited facts support preparing an unsent draft.",
      },
    });
    expect(resolution.statusCode, resolution.body).toBe(202);
    return {
      taskId: intakeBody.taskId,
      workflowId: intakeBody.workflowId,
      approvalId: approvalId!,
      traceId,
    };
  }

  async function configure(enabled: boolean) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/config",
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `gmail-config-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        enabled,
        allowedRecipientAddresses: [],
        allowedRecipientDomains: enabled ? ["example.com"] : [],
        credentialSecretReference: enabled ? "env://GMAIL_TEST_TOKEN" : null,
        reason: enabled
          ? "Enable controlled Phase 3 feature test"
          : "Exercise the organization kill switch",
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ configVersionId: string }>();
  }

  async function previewAndAuthorize(task: ApprovedTask) {
    const payload = {
      organizationId: usaId,
      to: "customer@example.com",
      subject: "Exact approved follow-up",
      body: "Hello,\n\nThis exact content remains an unsent Gmail draft.",
    };
    const preview = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/gmail-draft-preview`,
      headers: {
        "x-dev-user-email": executiveEmail,
        "idempotency-key": `gmail-preview-${randomUUID()}`,
        "x-trace-id": "different-http-trace-is-not-the-root",
      },
      payload,
    });
    expect(preview.statusCode, preview.body).toBe(202);
    const previewBody = preview.json<{
      previewId: string;
      renderedPayload: { to: string; subject: string; body: string };
      renderedPayloadHash: string;
      traceId: string;
    }>();
    expect(previewBody.renderedPayload).toEqual({
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
    });
    expect(previewBody.traceId).toBe(task.traceId);
    const beforeAuthorization = await withOrganizationScope(
      pool,
      {
        userId: "20000000-0000-4000-8000-000000000002",
        organizationIds: [usaId],
      },
      async (client) => {
        const commands = await client.query(
          `SELECT id
           FROM execution_commands
           WHERE task_id = $1
             AND provider_name = 'gmail_draft'`,
          [task.taskId],
        );
        const results = await client.query(
          "SELECT id FROM execution_results WHERE task_id = $1",
          [task.taskId],
        );
        return { commands: commands.rowCount, results: results.rowCount };
      },
    );
    expect(beforeAuthorization).toEqual({ commands: 0, results: 0 });
    const queueBeforeAuthorization = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    const queueBody = queueBeforeAuthorization.json<{
      counts: { awaitingExternalAuthorization: number };
      awaitingExternalAuthorization: Array<{ id: string }>;
    }>();
    expect(queueBody.counts.awaitingExternalAuthorization).toBeGreaterThan(0);
    expect(queueBody.awaitingExternalAuthorization).toContainEqual(
      expect.objectContaining({ id: task.taskId }),
    );

    const authorizationKey = `gmail-authorize-${randomUUID()}`;
    const authorization = await app.inject({
      method: "POST",
      url: `/v1/gmail-draft-previews/${previewBody.previewId}/authorization`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": authorizationKey,
      },
      payload: {
        organizationId: usaId,
        reason: "Exact recipient, subject, and body are authorized as a draft.",
      },
    });
    expect(authorization.statusCode, authorization.body).toBe(202);
    const authorizationBody = authorization.json<{
      authorizationId: string;
      executionCommandId: string;
      outboxEventId: string;
      traceId: string;
    }>();
    expect(authorizationBody.traceId).toBe(task.traceId);
    return { payload, previewBody, authorizationBody, authorizationKey };
  }

  it("ships disabled, exposes drafts.create only, and preserves internal execution", async () => {
    expect(GMAIL_DRAFT_CAPABILITIES).toEqual(["drafts.create"]);
    expect(GMAIL_COMPOSE_OAUTH_SCOPE).toBe(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(GMAIL_DRAFT_CAPABILITIES).not.toContain("messages.send");

    const task = await createApprovedTask("disabled-default");
    const blockedPreview = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/gmail-draft-preview`,
      headers: {
        "x-dev-user-email": executiveEmail,
        "idempotency-key": `disabled-preview-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        to: "customer@example.com",
        subject: "Blocked",
        body: "The connector is disabled.",
      },
    });
    expect(blockedPreview.statusCode).toBe(409);

    const internal = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/executions`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `internal-after-disabled-${randomUUID()}`,
      },
      payload: { organizationId: usaId },
    });
    expect(internal.statusCode, internal.body).toBe(202);
    expect(
      await processNextOutboxJob(pool, "disabled-internal", internalProvider),
    ).toBe("published");
    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${task.taskId}?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    expect(detail.json<{ task: { status: string } }>().task.status).toBe(
      "completed",
    );
    const sendRoute = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/messages.send`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    expect(sendRoute.statusCode).toBe(404);
  });

  it("previews exactly, enforces allowlist and isolation, authorizes once, and materializes one replay-safe draft", async () => {
    const connectorConfig = await configure(true);
    const task = await createApprovedTask("successful-draft");
    await expect(
      withOrganizationScope(
        pool,
        { userId: executiveId, organizationIds: [usaId] },
        async (client) => {
          const workflow = await client.query<{ version: number }>(
            "SELECT version FROM workflows WHERE id = $1",
            [task.workflowId],
          );
          await client.query(
            `SELECT *
             FROM transition_workflow(
               $1, $2, $3, $4, 'awaiting_external_authorization',
               'user', $5, $6, $7, $8, $9::jsonb
             )`,
            [
              task.workflowId,
              usaId,
              `forged-preview-${randomUUID()}`,
              workflow.rows[0]!.version,
              executiveId,
              "0".repeat(64),
              "1".repeat(64),
              task.traceId,
              JSON.stringify({ previewId: randomUUID() }),
            ],
          );
        },
      ),
    ).rejects.toThrow(/immutable Gmail draft preview/);

    const outsideAllowlist = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/gmail-draft-preview`,
      headers: {
        "x-dev-user-email": executiveEmail,
        "idempotency-key": `outside-allowlist-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        to: "customer@outside.invalid",
        subject: "Must not run",
        body: "Must not materialize.",
      },
    });
    expect(outsideAllowlist.statusCode).toBe(422);

    const { previewBody, authorizationBody, authorizationKey } =
      await previewAndAuthorize(task);
    await expect(
      adminPool.query(
        `UPDATE operating_layer.gmail_draft_connector_config_versions
         SET enabled = false
         WHERE id = $1`,
        [connectorConfig.configVersionId],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      adminPool.query(
        `UPDATE operating_layer.gmail_draft_previews
         SET body = 'tampered'
         WHERE id = $1`,
        [previewBody.previewId],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      adminPool.query(
        `UPDATE operating_layer.gmail_draft_authorizations
         SET reason = 'tampered'
         WHERE id = $1`,
        [authorizationBody.authorizationId],
      ),
    ).rejects.toThrow(/immutable/i);

    const crossOrgApi = await app.inject({
      method: "POST",
      url: `/v1/gmail-draft-previews/${previewBody.previewId}/authorization`,
      headers: {
        "x-dev-user-email": "fsi-operator@local.operating-layer",
        "idempotency-key": `cross-org-gmail-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        reason: "Unauthorized cross-organization attempt",
      },
    });
    expect(crossOrgApi.statusCode).toBe(403);
    const crossOrgRows = await withOrganizationScope(
      pool,
      { userId: fsiOperatorId, organizationIds: [fsiId] },
      async (client) =>
        (
          await client.query(
            "SELECT id FROM gmail_draft_previews WHERE id = $1",
            [previewBody.previewId],
          )
        ).rowCount,
    );
    expect(crossOrgRows).toBe(0);

    const duplicateAuthorization = await app.inject({
      method: "POST",
      url: `/v1/gmail-draft-previews/${previewBody.previewId}/authorization`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": authorizationKey,
      },
      payload: {
        organizationId: usaId,
        reason: "Exact recipient, subject, and body are authorized as a draft.",
      },
    });
    expect(duplicateAuthorization.statusCode).toBe(200);
    expect(duplicateAuthorization.json()).toMatchObject({
      authorizationId: authorizationBody.authorizationId,
      executionCommandId: authorizationBody.executionCommandId,
      duplicate: true,
    });

    let calls = 0;
    const transport: GmailDraftCreateTransport = {
      async createDraft() {
        calls += 1;
        return {
          draftId: "draft-stable-1",
          messageId: "message-stable-1",
          threadId: "thread-stable-1",
        };
      },
    };
    const gmailProvider = new GmailDraftExecutionProvider(transport);
    expect(
      await processNextOutboxJob(
        pool,
        "gmail-success",
        internalProvider,
        gmailProvider,
      ),
    ).toBe("published");
    expect(calls).toBe(1);

    await adminPool.query(
      `UPDATE operating_layer.outbox_events
       SET status = 'pending', published_at = NULL, available_at = now()
       WHERE id = $1`,
      [authorizationBody.outboxEventId],
    );
    expect(
      await processNextOutboxJob(
        pool,
        "gmail-redelivery",
        internalProvider,
        gmailProvider,
      ),
    ).toBe("published");
    expect(calls).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${task.taskId}?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    const body = detail.json<{
      task: { status: string };
      executionResults: Array<{
        output_payload: { draftId: string; draftLink: string };
        trace_id: string;
      }>;
      auditHistory: Array<{
        eventType: string;
        traceId: string;
        metadata: Record<string, unknown>;
      }>;
    }>();
    expect(body.task.status).toBe("completed");
    expect(body.executionResults).toHaveLength(1);
    expect(body.executionResults[0]?.output_payload.draftId).toBe(
      "draft-stable-1",
    );
    const created = body.auditHistory.find(
      (event) => event.eventType === "gmail_draft.created",
    );
    expect(created).toMatchObject({
      traceId: task.traceId,
      metadata: {
        draftId: "draft-stable-1",
        authorizationId: authorizationBody.authorizationId,
        capability: "drafts.create",
      },
    });
    expect(
      body.auditHistory
        .filter((event) =>
          [
            "approval.approved",
            "gmail_draft.previewed",
            "gmail_draft.authorized",
            "execution.started",
            "gmail_draft.created",
          ].includes(event.eventType),
        )
        .every((event) => event.traceId === task.traceId),
    ).toBe(true);
    await expect(verifyAuditChain(adminPool, usaId)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("halts a mid-flight command when disabled and returns to internal execution", async () => {
    await configure(true);
    const task = await createApprovedTask("kill-switch");
    const { authorizationBody } = await previewAndAuthorize(task);
    await expect(
      withOrganizationScope(
        pool,
        { userId: fsiOperatorId, organizationIds: [fsiId] },
        async (client) =>
          client.query(
            `SELECT *
             FROM abandon_gmail_draft_execution($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              authorizationBody.executionCommandId,
              usaId,
              "connector_disabled",
              task.traceId,
            ],
          ),
      ),
    ).rejects.toThrow(/organization access denied/);
    await configure(false);

    let calls = 0;
    const gmailProvider = new GmailDraftExecutionProvider({
      async createDraft() {
        calls += 1;
        return {
          draftId: "must-not-exist",
          messageId: "must-not-exist",
          threadId: null,
        };
      },
    });
    expect(
      await processNextOutboxJob(
        pool,
        "gmail-kill-switch",
        internalProvider,
        gmailProvider,
      ),
    ).toBe("published");
    expect(calls).toBe(0);

    const afterKill = await app.inject({
      method: "GET",
      url: `/v1/tasks/${task.taskId}?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    const killed = afterKill.json<{
      task: { status: string };
      gmailDraftAbandonments: Array<{ reason_code: string }>;
      executionResults: unknown[];
    }>();
    expect(killed.task.status).toBe("approved");
    expect(killed.gmailDraftAbandonments).toEqual([
      expect.objectContaining({ reason_code: "connector_disabled" }),
    ]);
    expect(killed.executionResults).toHaveLength(0);

    const internal = await app.inject({
      method: "POST",
      url: `/v1/approvals/${task.approvalId}/executions`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `internal-after-kill-${randomUUID()}`,
      },
      payload: { organizationId: usaId },
    });
    expect(internal.statusCode, internal.body).toBe(202);
    expect(
      await processNextOutboxJob(pool, "gmail-kill-internal", internalProvider),
    ).toBe("published");
  });

  it("retries a failed drafts.create within bounds and exposes the dead letter", async () => {
    await configure(true);
    const task = await createApprovedTask("dead-letter");
    const { authorizationBody } = await previewAndAuthorize(task);
    let calls = 0;
    const failingProvider = new GmailDraftExecutionProvider({
      async createDraft() {
        calls += 1;
        throw new Error("Synthetic Gmail drafts.create outage");
      },
    });

    expect(
      await processNextOutboxJob(
        pool,
        "gmail-failure-1",
        internalProvider,
        failingProvider,
      ),
    ).toBe("failed");
    await adminPool.query(
      "UPDATE operating_layer.outbox_events SET available_at = now() WHERE id = $1",
      [authorizationBody.outboxEventId],
    );
    expect(
      await processNextOutboxJob(
        pool,
        "gmail-failure-2",
        internalProvider,
        failingProvider,
      ),
    ).toBe("failed");
    await adminPool.query(
      "UPDATE operating_layer.outbox_events SET available_at = now() WHERE id = $1",
      [authorizationBody.outboxEventId],
    );
    expect(
      await processNextOutboxJob(
        pool,
        "gmail-failure-3",
        internalProvider,
        failingProvider,
      ),
    ).toBe("dead_letter");
    expect(calls).toBe(3);

    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(
      queue.json<{ jobFailures: Array<{ id: string; status: string }> }>()
        .jobFailures,
    ).toContainEqual(
      expect.objectContaining({
        id: authorizationBody.outboxEventId,
        status: "dead_letter",
      }),
    );
  });
});
