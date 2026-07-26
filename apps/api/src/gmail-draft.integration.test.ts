import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@operating-layer/audit";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  withOrganizationScope,
  withWorkerOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import {
  GMAIL_COMPOSE_SCOPE,
  RsaEnvelopeCredentialDecryptor,
  RsaEnvelopeCredentialEncryptor,
} from "@operating-layer/connectors";
import {
  DeterministicInternalExecutionProvider,
  GmailDraftExecutionProvider,
  GMAIL_COMPOSE_OAUTH_SCOPE,
  GMAIL_DRAFT_CAPABILITIES,
  type ExecutionProvider,
  type GmailDraftCreateTransport,
} from "@operating-layer/executors";
import {
  drainOutbox,
  assertGmailCredentialStartup,
  loadExecutionCredential,
  processNextOutboxJob,
  type GmailCredentialRuntime,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const usaId = "10000000-0000-4000-8000-000000000003";
const fsiId = "10000000-0000-4000-8000-000000000002";
const cultivusId = "10000000-0000-4000-8000-000000000004";
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
  let workerPool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  let credentialRuntime: GmailCredentialRuntime;
  let tokenCounter = 0;
  const internalProvider = new DeterministicInternalExecutionProvider();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    const workerDatabaseUrl = process.env.DATABASE_URL_WORKER_TEST;
    if (!databaseUrl || !runtimeDatabaseUrl || !workerDatabaseUrl) {
      throw new Error("Feature-test database URLs are required");
    }
    const keyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "der", type: "spki" },
      privateKeyEncoding: { format: "der", type: "pkcs8" },
    });
    const encryptor = new RsaEnvelopeCredentialEncryptor(
      keyPair.publicKey.toString("base64"),
    );
    credentialRuntime = {
      decryptor: new RsaEnvelopeCredentialDecryptor(
        keyPair.privateKey.toString("base64"),
      ),
      revoker: { enabled: true, async revoke() {} },
    };
    adminPool = createDatabasePool(databaseUrl);
    pool = createDatabasePool(runtimeDatabaseUrl);
    workerPool = createDatabasePool(workerDatabaseUrl);
    await assertSafeRuntimeDatabaseIdentity(pool);
    app = await buildApi({
      pool,
      identityProvider: new DevelopmentHeaderIdentityProvider(),
      credentialEncryptor: encryptor,
      logger: false,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await workerPool.end();
    await adminPool.end();
  });

  async function createApprovedTask(
    label: string,
    organizationId = usaId,
  ): Promise<ApprovedTask> {
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
        organizationId,
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
      workerPool,
      `gmail-setup-${label}`,
      20,
      internalProvider,
      undefined,
      credentialRuntime,
    );
    expect(drained.failed).toBe(0);
    expect(drained.deadLetter).toBe(0);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${intakeBody.taskId}?organizationId=${organizationId}`,
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
        organizationId,
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

  async function configure(enabled: boolean, organizationId = usaId) {
    const provisioned = enabled
      ? await provisionCredential({ organizationId })
      : null;
    const response = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/config",
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `gmail-config-${randomUUID()}`,
      },
      payload: {
        organizationId,
        enabled,
        allowedRecipientAddresses: [],
        allowedRecipientDomains: enabled ? ["example.com"] : [],
        reason: enabled
          ? "Enable controlled Phase 3 feature test"
          : "Exercise the organization kill switch",
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    return {
      ...response.json<{ configVersionId: string }>(),
      accessToken: provisioned?.accessToken ?? null,
    };
  }

  async function provisionCredential(input?: {
    organizationId?: string;
    accessToken?: string;
    grantedScopes?: string[];
    idempotencyKey?: string;
  }) {
    tokenCounter += 1;
    const accessToken =
      input?.accessToken ??
      `gmail-test-token-${tokenCounter}-${"x".repeat(32)}`;
    const idempotencyKey =
      input?.idempotencyKey ?? `gmail-credential-${randomUUID()}`;
    const credential = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/credentials",
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        organizationId: input?.organizationId ?? usaId,
        accessToken,
        grantedScopes: input?.grantedScopes ?? [GMAIL_COMPOSE_SCOPE],
        reason: "Provision encrypted feature-test credential",
      },
    });
    return { response: credential, accessToken, idempotencyKey };
  }

  async function previewAndAuthorize(
    task: ApprovedTask,
    organizationId = usaId,
  ) {
    const payload = {
      organizationId,
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
      payload: { ...payload, organizationId },
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
        organizationIds: [organizationId],
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
      url: `/v1/executive-queue?organizationId=${organizationId}`,
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
        organizationId,
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
    const seededState = await adminPool.query<{
      configured: boolean;
      credential_bound: boolean;
      globally_killed: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM operating_layer.gmail_draft_connector_bindings
           WHERE organization_id = $1
         ) AS configured,
         EXISTS (
           SELECT 1
           FROM operating_layer.gmail_draft_credential_bindings
           WHERE organization_id = $1
             AND active_credential_version_id IS NOT NULL
         ) AS credential_bound,
         killed AS globally_killed
       FROM operating_layer.gmail_draft_global_kill_switch
       WHERE singleton`,
      [usaId],
    );
    expect(seededState.rows[0]).toEqual({
      configured: false,
      credential_bound: false,
      globally_killed: false,
    });

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
      await processNextOutboxJob(
        workerPool,
        "disabled-internal",
        internalProvider,
        undefined,
        credentialRuntime,
      ),
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

  it("cannot recover raw credential bytes, cross organization boundaries, broaden scope, or reuse a rotated version", async () => {
    await assertGmailCredentialStartup(workerPool, credentialRuntime);
    await expect(
      assertGmailCredentialStartup(pool, credentialRuntime),
    ).rejects.toThrow(/permission denied|worker role/i);
    const first = await provisionCredential({
      accessToken: `first-plaintext-token-${"a".repeat(40)}`,
      idempotencyKey: `credential-idempotency-${randomUUID()}`,
    });
    expect(first.response.statusCode, first.response.body).toBe(202);
    const firstBody = first.response.json<{
      credentialVersionId: string;
      duplicate: boolean;
    }>();

    const raw = await adminPool.query<{
      algorithm: string;
      ciphertext: string;
      nonce: string;
      authentication_tag: string;
      wrapped_data_key: string;
      token_fingerprint: string;
    }>(
      `SELECT algorithm, ciphertext, nonce, authentication_tag,
              wrapped_data_key, token_fingerprint
       FROM operating_layer.gmail_draft_credential_versions
       WHERE id = $1`,
      [firstBody.credentialVersionId],
    );
    const rawCredential = raw.rows[0]!;
    expect(rawCredential.algorithm).toBe("rsa-oaep-sha256+aes-256-gcm-v1");
    expect(rawCredential.ciphertext).not.toContain(first.accessToken);
    expect(rawCredential.wrapped_data_key).not.toContain(first.accessToken);
    expect(
      Buffer.from(rawCredential.ciphertext, "base64").equals(
        Buffer.from(first.accessToken, "utf8"),
      ),
    ).toBe(false);
    expect(rawCredential.token_fingerprint).toHaveLength(64);

    const unrelatedKeyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "der", type: "spki" },
      privateKeyEncoding: { format: "der", type: "pkcs8" },
    });
    const unrelatedDecryptor = new RsaEnvelopeCredentialDecryptor(
      unrelatedKeyPair.privateKey.toString("base64"),
    );
    expect(() =>
      unrelatedDecryptor.decrypt(
        {
          algorithm: "rsa-oaep-sha256+aes-256-gcm-v1",
          ciphertext: rawCredential.ciphertext,
          nonce: rawCredential.nonce,
          authenticationTag: rawCredential.authentication_tag,
          wrappedDataKey: rawCredential.wrapped_data_key,
          fingerprint: rawCredential.token_fingerprint,
        },
        {
          organizationId: usaId,
          credentialVersionId: firstBody.credentialVersionId,
        },
      ),
    ).toThrow();

    const duplicate = await provisionCredential({
      accessToken: first.accessToken,
      idempotencyKey: first.idempotencyKey,
    });
    expect(duplicate.response.statusCode, duplicate.response.body).toBe(200);
    expect(duplicate.response.json()).toMatchObject({
      credentialVersionId: firstBody.credentialVersionId,
      duplicate: true,
    });

    const broaderScope = await provisionCredential({
      grantedScopes: [
        GMAIL_COMPOSE_SCOPE,
        "https://www.googleapis.com/auth/gmail.modify",
      ],
    });
    expect(broaderScope.response.statusCode).toBe(400);
    expect(broaderScope.response.body).not.toContain(broaderScope.accessToken);

    const crossOrgApi = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/credentials/revoke",
      headers: {
        "x-dev-user-email": "fsi-operator@local.operating-layer",
        "idempotency-key": `cross-org-credential-revoke-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        reason: "Attempt to revoke another organization's credential",
      },
    });
    expect(crossOrgApi.statusCode).toBe(403);

    await expect(
      pool.query(
        "SELECT id FROM operating_layer.gmail_draft_credential_versions",
      ),
    ).rejects.toThrow(/permission denied/i);
    const hiddenByRls = await withWorkerOrganizationScope(
      workerPool,
      { userId: fsiOperatorId, organizationIds: [fsiId] },
      async (client) =>
        (
          await client.query(
            "SELECT id FROM gmail_draft_credential_versions WHERE id = $1",
            [firstBody.credentialVersionId],
          )
        ).rowCount,
    );
    expect(hiddenByRls).toBe(0);
    const bindingHiddenFromApplicationRole = await withOrganizationScope(
      pool,
      { userId: fsiOperatorId, organizationIds: [fsiId] },
      async (client) =>
        (
          await client.query(
            `SELECT active_credential_version_id
             FROM gmail_draft_credential_bindings
             WHERE organization_id = $1`,
            [usaId],
          )
        ).rowCount,
    );
    expect(bindingHiddenFromApplicationRole).toBe(0);
    await expect(
      withWorkerOrganizationScope(
        workerPool,
        { userId: fsiOperatorId, organizationIds: [fsiId] },
        async (client) =>
          client.query(
            "SELECT * FROM load_gmail_draft_credential($1, $2, $3, $4)",
            [
              firstBody.credentialVersionId,
              usaId,
              "execution",
              "trace-cross-org-load-forbidden",
            ],
          ),
      ),
    ).rejects.toThrow(/organization access denied/i);

    const second = await provisionCredential({
      accessToken: `second-plaintext-token-${"b".repeat(40)}`,
    });
    expect(second.response.statusCode, second.response.body).toBe(202);
    const secondBody = second.response.json<{
      credentialVersionId: string;
      replacedCredentialVersionId: string;
    }>();
    expect(secondBody.replacedCredentialVersionId).toBe(
      firstBody.credentialVersionId,
    );
    const rotationState = await adminPool.query<{
      version_count: string;
      active_credential_version_id: string;
      first_version_count: string;
      second_version_count: string;
    }>(
      `SELECT
         count(version.id) AS version_count,
         binding.active_credential_version_id,
         count(version.id) FILTER (WHERE version.id = $2) AS first_version_count,
         count(version.id) FILTER (WHERE version.id = $3) AS second_version_count
       FROM operating_layer.gmail_draft_credential_bindings binding
       JOIN operating_layer.gmail_draft_credential_versions version
         ON version.organization_id = binding.organization_id
       WHERE binding.organization_id = $1
       GROUP BY binding.active_credential_version_id`,
      [usaId, firstBody.credentialVersionId, secondBody.credentialVersionId],
    );
    expect(rotationState.rows[0]).toEqual({
      version_count: "2",
      active_credential_version_id: secondBody.credentialVersionId,
      first_version_count: "1",
      second_version_count: "1",
    });
    await expect(
      loadExecutionCredential(workerPool, credentialRuntime, {
        organizationId: usaId,
        userId: executiveId,
        credentialVersionId: firstBody.credentialVersionId,
        traceId: "trace-old-credential-must-not-load",
        requestId: "request-old-credential-must-not-load",
      }),
    ).rejects.toThrow(/not active/i);
    const activeCredential = await loadExecutionCredential(
      workerPool,
      credentialRuntime,
      {
        organizationId: usaId,
        userId: executiveId,
        credentialVersionId: secondBody.credentialVersionId,
        traceId: "trace-new-credential-load",
        requestId: "request-new-credential-load",
      },
    );
    expect(activeCredential).toBeDefined();
    activeCredential.dispose();

    const durableText = await adminPool.query<{ durable_text: string }>(
      `SELECT
         coalesce(string_agg(metadata::text || trace_id || request_id, ''), '')
           AS durable_text
       FROM operating_layer.audit_events
       WHERE organization_id = $1`,
      [usaId],
    );
    expect(durableText.rows[0]?.durable_text).not.toContain(first.accessToken);
    expect(durableText.rows[0]?.durable_text).not.toContain(second.accessToken);

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/credentials/revoke",
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `explicit-revoke-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        reason: "Exercise explicit local invalidation and OAuth revocation",
      },
    });
    expect(revoked.statusCode, revoked.body).toBe(202);
    expect(revoked.json()).toMatchObject({
      invalidatedCredentialVersionId: secondBody.credentialVersionId,
    });
    await expect(
      loadExecutionCredential(workerPool, credentialRuntime, {
        organizationId: usaId,
        userId: executiveId,
        credentialVersionId: secondBody.credentialVersionId,
        traceId: "trace-revoked-credential-must-not-load",
        requestId: "request-revoked-credential-must-not-load",
      }),
    ).rejects.toThrow(/not active/i);

    const drained = await drainOutbox(
      workerPool,
      "credential-rotation-revoker",
      10,
      internalProvider,
      undefined,
      credentialRuntime,
    );
    expect(drained.failed).toBe(0);
    const revocationAudit = await adminPool.query<{ event_type: string }>(
      `SELECT event_type FROM operating_layer.audit_events
       WHERE organization_id = $1
         AND event_type IN (
           'gmail_draft.credential_revocation_requested',
           'gmail_draft.credential_revoked'
         )`,
      [usaId],
    );
    expect(revocationAudit.rows.map((row) => row.event_type)).toContain(
      "gmail_draft.credential_revoked",
    );
  });

  it("previews exactly, enforces allowlist and isolation, authorizes once, and materializes one replay-safe draft", async () => {
    const connectorConfig = await configure(true);
    const task = await createApprovedTask("successful-draft");
    await expect(
      withOrganizationScope(
        workerPool,
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
        workerPool,
        "gmail-success",
        internalProvider,
        gmailProvider,
        credentialRuntime,
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
        workerPool,
        "gmail-redelivery",
        internalProvider,
        gmailProvider,
        credentialRuntime,
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
        workerPool,
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
    const disabledCredential = await adminPool.query<{
      active_credential_version_id: string | null;
    }>(
      `SELECT active_credential_version_id
       FROM operating_layer.gmail_draft_credential_bindings
       WHERE organization_id = $1`,
      [usaId],
    );
    expect(disabledCredential.rows[0]?.active_credential_version_id).toBeNull();

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
        workerPool,
        "gmail-kill-switch",
        internalProvider,
        gmailProvider,
        credentialRuntime,
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
      await processNextOutboxJob(
        workerPool,
        "gmail-kill-internal",
        internalProvider,
        undefined,
        credentialRuntime,
      ),
    ).toBe("published");
  });

  it("retries a failed drafts.create within bounds and exposes the dead letter", async () => {
    const failureConfig = await configure(true);
    const task = await createApprovedTask("dead-letter");
    const { authorizationBody } = await previewAndAuthorize(task);
    let calls = 0;
    const failingProvider = new GmailDraftExecutionProvider({
      async createDraft(request) {
        calls += 1;
        throw new Error(
          `Synthetic Gmail drafts.create outage ${request.accessToken}`,
        );
      },
    });

    expect(
      await processNextOutboxJob(
        workerPool,
        "gmail-failure-1",
        internalProvider,
        failingProvider,
        credentialRuntime,
      ),
    ).toBe("failed");
    await adminPool.query(
      "UPDATE operating_layer.outbox_events SET available_at = now() WHERE id = $1",
      [authorizationBody.outboxEventId],
    );
    expect(
      await processNextOutboxJob(
        workerPool,
        "gmail-failure-2",
        internalProvider,
        failingProvider,
        credentialRuntime,
      ),
    ).toBe("failed");
    await adminPool.query(
      "UPDATE operating_layer.outbox_events SET available_at = now() WHERE id = $1",
      [authorizationBody.outboxEventId],
    );
    expect(
      await processNextOutboxJob(
        workerPool,
        "gmail-failure-3",
        internalProvider,
        failingProvider,
        credentialRuntime,
      ),
    ).toBe("dead_letter");
    expect(calls).toBe(3);
    const safeFailure = await adminPool.query<{
      safe_error_message: string | null;
    }>(
      `SELECT safe_error_message
       FROM operating_layer.outbox_events WHERE id = $1`,
      [authorizationBody.outboxEventId],
    );
    expect(safeFailure.rows[0]?.safe_error_message).not.toContain(
      failureConfig.accessToken,
    );
    expect(safeFailure.rows[0]?.safe_error_message).toContain("[REDACTED]");
    const durableLeakSurface = await adminPool.query<{
      serialized_output: string;
    }>(
      `SELECT concat_ws(
         '',
         coalesce((
           SELECT string_agg(to_jsonb(event)::text, '')
           FROM operating_layer.audit_events event
           WHERE event.organization_id = $1
             AND event.trace_id = $2
         ), ''),
         coalesce((
           SELECT string_agg(to_jsonb(job)::text, '')
           FROM operating_layer.outbox_events job
           WHERE job.organization_id = $1
             AND job.trace_id = $2
         ), ''),
         coalesce((
           SELECT string_agg(to_jsonb(transition)::text, '')
           FROM operating_layer.workflow_transitions transition
           WHERE transition.organization_id = $1
             AND transition.trace_id = $2
         ), ''),
         coalesce((
           SELECT string_agg(to_jsonb(command)::text, '')
           FROM operating_layer.execution_commands command
           WHERE command.organization_id = $1
             AND command.trace_id = $2
         ), ''),
         coalesce((
           SELECT string_agg(to_jsonb(result)::text, '')
           FROM operating_layer.execution_results result
           WHERE result.organization_id = $1
             AND result.trace_id = $2
         ), ''),
         coalesce((
           SELECT string_agg(to_jsonb(event)::text, '')
           FROM operating_layer.gmail_draft_credential_lifecycle_events event
           WHERE event.organization_id = $1
             AND event.trace_id = $2
         ), '')
       ) AS serialized_output`,
      [usaId, task.traceId],
    );
    expect(durableLeakSurface.rows[0]?.serialized_output).not.toContain(
      failureConfig.accessToken,
    );

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

  it("blocks attempted execution in every organization after the global kill", async () => {
    await configure(true);
    await configure(true, fsiId);
    const usaTask = await createApprovedTask("global-kill-usa", usaId);
    const fsiTask = await createApprovedTask("global-kill-fsi", fsiId);
    const usaAuthorization = await previewAndAuthorize(usaTask, usaId);
    const fsiAuthorization = await previewAndAuthorize(fsiTask, fsiId);
    const activeBeforeKill = await adminPool.query<{
      organization_id: string;
      active_credential_version_id: string;
    }>(
      `SELECT organization_id, active_credential_version_id
       FROM operating_layer.gmail_draft_credential_bindings
       WHERE organization_id IN ($1, $2)
       ORDER BY organization_id`,
      [usaId, fsiId],
    );
    expect(activeBeforeKill.rows).toHaveLength(2);

    const traceId = `trace-global-kill-${randomUUID()}`;
    const killed = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/global-kill",
      headers: {
        "x-dev-user-email": adminEmail,
        "x-trace-id": traceId,
      },
      payload: {
        killed: true,
        reason: "Feature-test global connector shutdown",
      },
    });
    expect(killed.statusCode, killed.body).toBe(202);
    expect(killed.json()).toMatchObject({
      killed: true,
      affectedOrganizations: 2,
      traceId,
    });
    const state = await adminPool.query<{
      killed: boolean;
      active_count: string;
    }>(
      `SELECT
         kill.killed,
         count(binding.active_credential_version_id)
           FILTER (WHERE binding.organization_id IN ($1, $2)) AS active_count
       FROM operating_layer.gmail_draft_global_kill_switch kill
       LEFT JOIN operating_layer.gmail_draft_credential_bindings binding
         ON true
       WHERE kill.singleton
       GROUP BY kill.killed`,
      [usaId, fsiId],
    );
    expect(state.rows[0]).toMatchObject({ killed: true, active_count: "0" });
    for (const credential of activeBeforeKill.rows) {
      await expect(
        loadExecutionCredential(workerPool, credentialRuntime, {
          organizationId: credential.organization_id,
          userId: executiveId,
          credentialVersionId: credential.active_credential_version_id,
          traceId: `trace-global-kill-load-${credential.organization_id}`,
          requestId: `request-global-kill-load-${credential.organization_id}`,
        }),
      ).rejects.toThrow(/not active/i);
    }

    const rejectedEnable = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/config",
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `config-during-global-kill-${randomUUID()}`,
      },
      payload: {
        organizationId: usaId,
        enabled: true,
        allowedRecipientAddresses: [],
        allowedRecipientDomains: ["example.com"],
        reason: "Must remain disabled during the global kill",
      },
    });
    expect(rejectedEnable.statusCode).toBe(409);

    let draftCreateCalls = 0;
    const forbiddenProvider = new GmailDraftExecutionProvider({
      async createDraft() {
        draftCreateCalls += 1;
        throw new Error("Global kill failed to block drafts.create");
      },
    });
    const drain = await drainOutbox(
      workerPool,
      "global-kill-revoker",
      40,
      internalProvider,
      forbiddenProvider,
      credentialRuntime,
    );
    expect(drain.failed).toBe(0);
    expect(draftCreateCalls).toBe(0);
    for (const proof of [
      {
        task: usaTask,
        organizationId: usaId,
        executionCommandId:
          usaAuthorization.authorizationBody.executionCommandId,
      },
      {
        task: fsiTask,
        organizationId: fsiId,
        executionCommandId:
          fsiAuthorization.authorizationBody.executionCommandId,
      },
    ]) {
      const detail = await app.inject({
        method: "GET",
        url: `/v1/tasks/${proof.task.taskId}?organizationId=${proof.organizationId}`,
        headers: { "x-dev-user-email": executiveEmail },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(
        detail.json<{
          task: { status: string };
          gmailDraftAbandonments: Array<{
            execution_command_id: string;
          }>;
          executionResults: unknown[];
        }>(),
      ).toMatchObject({
        task: { status: "approved" },
        gmailDraftAbandonments: [
          { execution_command_id: proof.executionCommandId },
        ],
        executionResults: [],
      });
    }
    const audited = await adminPool.query<{ organization_id: string }>(
      `SELECT organization_id
       FROM operating_layer.audit_events
       WHERE event_type = 'gmail_draft.global_kill_enabled'
         AND trace_id = $1
       ORDER BY organization_id`,
      [traceId],
    );
    expect(audited.rows.map((row) => row.organization_id)).toEqual([
      fsiId,
      usaId,
    ]);

    const cleared = await app.inject({
      method: "POST",
      url: "/v1/connectors/gmail-draft/global-kill",
      headers: { "x-dev-user-email": adminEmail },
      payload: {
        killed: false,
        reason: "Clear the feature-test switch; credentials stay invalidated",
      },
    });
    expect(cleared.statusCode, cleared.body).toBe(202);

    await configure(true, cultivusId);
    const privilegedClient = await adminPool.connect();
    try {
      await privilegedClient.query("BEGIN");
      await privilegedClient.query(
        `SELECT set_config(
           'app.gmail_credential_binding_guard',
           'gmail_credential_binding:v1',
           true
         )`,
      );
      await privilegedClient.query(
        `UPDATE operating_layer.gmail_draft_credential_bindings
         SET active_credential_version_id = NULL
         WHERE organization_id = $1`,
        [cultivusId],
      );
      await privilegedClient.query("COMMIT");
    } catch (error) {
      await privilegedClient.query("ROLLBACK");
      throw error;
    } finally {
      privilegedClient.release();
    }
    await expect(
      assertGmailCredentialStartup(workerPool, credentialRuntime),
    ).rejects.toThrow(/startup invariant failed/i);
  });

  it("rejects common-valid but Gmail-invalid provider output before materialization", async () => {
    await configure(true);
    const task = await createApprovedTask("malformed-gmail-output");
    const { authorizationBody } = await previewAndAuthorize(task);
    const malformedProvider: ExecutionProvider = {
      id: "malformed-gmail-feature-fixture",
      kind: "external",
      enabled: true,
      async execute() {
        return {
          outcome: "succeeded",
          summary: "Common-valid output missing Gmail-specific proof fields.",
          output: {
            draftId: "partial-draft-must-not-persist",
          },
        };
      },
    };

    expect(
      await processNextOutboxJob(
        workerPool,
        "malformed-gmail-output-worker",
        internalProvider,
        malformedProvider,
        credentialRuntime,
      ),
    ).toBe("failed");

    const afterFirstAttempt = await adminPool.query<{
      workflow_state: string;
      result_count: string;
      created_audit_count: string;
      failed_audit_count: string;
      started_audit_count: string;
      outbox_status: string;
      safe_error_message: string | null;
    }>(
      `SELECT
         workflow.current_state AS workflow_state,
         (
           SELECT count(*)::text
           FROM operating_layer.execution_results result
           WHERE result.execution_command_id = $3
         ) AS result_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events audit
           WHERE audit.workflow_id = workflow.id
             AND audit.event_type = 'gmail_draft.created'
         ) AS created_audit_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events audit
           WHERE audit.workflow_id = workflow.id
             AND audit.event_type = 'execution.failed'
         ) AS failed_audit_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events audit
           WHERE audit.workflow_id = workflow.id
             AND audit.event_type = 'execution.started'
         ) AS started_audit_count,
         outbox.status AS outbox_status,
         outbox.safe_error_message
       FROM operating_layer.workflows workflow
       JOIN operating_layer.outbox_events outbox ON outbox.id = $4
       WHERE workflow.id = $2
         AND workflow.organization_id = $1`,
      [
        usaId,
        task.workflowId,
        authorizationBody.executionCommandId,
        authorizationBody.outboxEventId,
      ],
    );
    expect(afterFirstAttempt.rows[0]).toEqual({
      workflow_state: "executing",
      result_count: "0",
      created_audit_count: "0",
      failed_audit_count: "0",
      started_audit_count: "1",
      outbox_status: "failed",
      safe_error_message: "Execution provider returned invalid output",
    });

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await adminPool.query(
        `UPDATE operating_layer.outbox_events
         SET available_at = now()
         WHERE id = $1`,
        [authorizationBody.outboxEventId],
      );
      expect(
        await processNextOutboxJob(
          workerPool,
          "malformed-gmail-output-worker",
          internalProvider,
          malformedProvider,
          credentialRuntime,
        ),
      ).toBe(attempt === 3 ? "dead_letter" : "failed");
    }

    const terminal = await adminPool.query<{
      workflow_state: string;
      outbox_status: string;
      outcome: string;
      error_code: string;
      output_payload: Record<string, unknown>;
      trace_id: string;
      created_audit_count: string;
      failure_audit_count: string;
    }>(
      `SELECT
         workflow.current_state AS workflow_state,
         outbox.status AS outbox_status,
         result.outcome,
         result.error_code,
         result.output_payload,
         result.trace_id,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events audit
           WHERE audit.workflow_id = workflow.id
             AND audit.event_type = 'gmail_draft.created'
         ) AS created_audit_count,
         (
           SELECT count(*)::text
           FROM operating_layer.audit_events audit
           WHERE audit.workflow_id = workflow.id
             AND audit.event_type = 'execution.failed'
             AND audit.trace_id = $5
         ) AS failure_audit_count
       FROM operating_layer.workflows workflow
       JOIN operating_layer.outbox_events outbox ON outbox.id = $4
       JOIN operating_layer.execution_results result
         ON result.execution_command_id = $3
       WHERE workflow.id = $2
         AND workflow.organization_id = $1`,
      [
        usaId,
        task.workflowId,
        authorizationBody.executionCommandId,
        authorizationBody.outboxEventId,
        task.traceId,
      ],
    );
    expect(terminal.rows[0]).toMatchObject({
      workflow_state: "execution_failed",
      outbox_status: "dead_letter",
      outcome: "failed",
      error_code: "executor_output_invalid",
      output_payload: {},
      trace_id: task.traceId,
      created_audit_count: "0",
      failure_audit_count: "1",
    });
    expect(JSON.stringify(terminal.rows[0])).not.toContain(
      "partial-draft-must-not-persist",
    );
    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${usaId}`,
      headers: { "x-dev-user-email": executiveEmail },
    });
    expect(
      queue.json<{
        jobFailures: Array<{ id: string; status: string }>;
      }>().jobFailures,
    ).toContainEqual(
      expect.objectContaining({
        id: authorizationBody.outboxEventId,
        status: "dead_letter",
      }),
    );
  });
});
