import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@operating-layer/audit";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  UnsafeRuntimeDatabaseIdentityError,
  withOrganizationScope,
  type DatabasePool,
} from "@operating-layer/db";
import {
  activateApprovalPolicy,
  createApprovalPolicyVersion,
  drainOutbox,
  loadActiveApprovalPolicy,
  processNextOutboxJob,
  reapExpiredIdempotencyKeys,
  requestApprovalPolicyActivation,
  resolveApplicationPrincipal,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const blcsId = "10000000-0000-4000-8000-000000000001";
const fsiId = "10000000-0000-4000-8000-000000000002";
const blcsOperatorId = "20000000-0000-4000-8000-000000000003";
const blcsOperatorEmail = "operator@local.operating-layer";
const fsiOperatorEmail = "fsi-operator@local.operating-layer";
const adminEmail = "admin@local.operating-layer";
const executiveEmail = "executive@local.operating-layer";
const approverEmail = "approver@local.operating-layer";

describe("Phase 1 manual issue vertical slice", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  let createdTaskId: string;
  let createdWorkflowId: string;
  let createdApprovalId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL_TEST is required");
    }
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!runtimeDatabaseUrl) {
      throw new Error("DATABASE_URL_RUNTIME_TEST is required");
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

  it("creates, deduplicates, classifies, recommends, and queues approval", async () => {
    const idempotencyKey = `feature-${randomUUID()}`;
    const payload = {
      organizationId: blcsId,
      title: "High-value overdue invoice needs customer follow-up",
      description:
        "A $125,000 receivable is overdue. Draft a customer escalation for approval.",
      dueDate: "2026-07-20",
      financialExposure: 125_000,
      financialExposureCurrency: "USD",
      retentionClassification: "financial_support",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
        "x-trace-id": "trace-feature-intake",
      },
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);
    const firstBody = first.json<{
      taskId: string;
      workflowId: string;
      workflowState: string;
      duplicate: boolean;
    }>();
    expect(firstBody.workflowState).toBe("normalized");
    expect(firstBody.duplicate).toBe(false);
    createdTaskId = firstBody.taskId;
    createdWorkflowId = firstBody.workflowId;

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      taskId: createdTaskId,
      workflowId: createdWorkflowId,
      duplicate: true,
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
      },
      payload: { ...payload, title: "Different issue" },
    });
    expect(conflict.statusCode).toBe(409);

    const drained = await drainOutbox(pool, "feature-test-worker");
    expect(drained).toMatchObject({
      published: 2,
      failed: 0,
      deadLetter: 0,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${createdTaskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": blcsOperatorEmail },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<{
      task: { task_type: string; priority: string; status: string };
      sources: Array<{
        checksumAlgorithm: string;
        sourceTimestamp: string;
        ingestedAt: string;
        schemaVersion: string;
        retentionClassification: string;
      }>;
      workflows: Array<{ current_state: string }>;
      transitions: Array<{ to_state: string }>;
      recommendations: Array<{
        risk_level: number;
        requires_approval: boolean;
      }>;
      approvals: Array<{
        id: string;
        status: string;
        policy_version_id: string;
        policy_content_hash: string;
      }>;
      auditHistory: Array<{ eventType: string; eventHash: string }>;
    }>();
    expect(detailBody.task).toMatchObject({
      task_type: "collections",
      priority: "P1",
      status: "awaiting_approval",
    });
    expect(detailBody.sources[0]).toMatchObject({
      checksumAlgorithm: "sha256",
      schemaVersion: "manual-issue.v1",
      retentionClassification: "financial_support",
    });
    expect(detailBody.sources[0]?.sourceTimestamp).toBeTruthy();
    expect(detailBody.sources[0]?.ingestedAt).toBeTruthy();
    expect(detailBody.workflows[0]?.current_state).toBe("awaiting_approval");
    expect(detailBody.transitions.map((row) => row.to_state)).toEqual([
      "normalized",
      "classified",
      "recommended",
      "awaiting_approval",
    ]);
    expect(detailBody.recommendations[0]).toMatchObject({
      risk_level: 4,
      requires_approval: true,
    });
    expect(detailBody.approvals[0]?.status).toBe("pending");
    expect(detailBody.approvals[0]?.policy_version_id).toBe(
      "62000000-0000-4000-8000-000000000001",
    );
    expect(detailBody.approvals[0]?.policy_content_hash).toHaveLength(64);
    createdApprovalId = detailBody.approvals[0]!.id;
    expect(detailBody.auditHistory.length).toBeGreaterThanOrEqual(5);
    expect(
      detailBody.auditHistory.every((event) => event.eventHash.length === 64),
    ).toBe(true);

    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": blcsOperatorEmail },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({
      counts: {
        open: 1,
        overdue: 1,
        blocked: 0,
        approvalPending: 1,
      },
    });

    const traceEvidence = await withOrganizationScope(
      pool,
      { userId: blcsOperatorId, organizationIds: [blcsId] },
      async (client) => {
        const result = await client.query<{
          intake_trace: string;
          worker_trace: string;
          audit_trace: string;
        }>(
          `SELECT
             (
               SELECT trace_id
               FROM outbox_events
               WHERE aggregate_id = $1
                 AND topic = 'issue.classify'
               LIMIT 1
             ) AS intake_trace,
             (
               SELECT trace_id
               FROM workflow_transitions
               WHERE workflow_id = $1
                 AND to_state = 'classified'
               LIMIT 1
             ) AS worker_trace,
             (
               SELECT trace_id
               FROM audit_events
               WHERE workflow_id = $1
                 AND event_type = 'task.classified'
               LIMIT 1
             ) AS audit_trace`,
          [createdWorkflowId],
        );
        return result.rows[0]!;
      },
    );
    expect(traceEvidence).toEqual({
      intake_trace: "trace-feature-intake",
      worker_trace: "trace-feature-intake",
      audit_trace: "trace-feature-intake",
    });
  });

  it("rejects RLS-bypassing runtime identities and accepts the scoped role", async () => {
    const unsafeIdentity = await assertSafeRuntimeDatabaseIdentity(
      adminPool,
    ).catch((error: unknown) => error);
    expect(unsafeIdentity).toBeInstanceOf(UnsafeRuntimeDatabaseIdentityError);
    if (!(unsafeIdentity instanceof UnsafeRuntimeDatabaseIdentityError)) {
      throw new Error("Expected the migration identity to be rejected");
    }
    expect(unsafeIdentity.message).toMatch(/superuser/);
    expect(unsafeIdentity.identity.ownedRlsTables).toContain("tasks");

    await expect(
      assertSafeRuntimeDatabaseIdentity(pool),
    ).resolves.toMatchObject({
      roleName: "operating_layer_runtime",
      superuser: false,
      bypassRls: false,
      ownedRlsTables: [],
    });
  });

  it("enforces organization authorization in the API and row-level security", async () => {
    const unauthorizedQueue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": fsiOperatorEmail },
    });
    expect(unauthorizedQueue.statusCode).toBe(403);

    const unauthorizedTask = await app.inject({
      method: "GET",
      url: `/v1/tasks/${createdTaskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": fsiOperatorEmail },
    });
    expect(unauthorizedTask.statusCode).toBe(403);

    const rowsVisibleAcrossEntity = await withOrganizationScope(
      pool,
      { userId: blcsOperatorId, organizationIds: [blcsId] },
      async (client) => {
        const result = await client.query(
          `SELECT id FROM tasks WHERE organization_id = $1`,
          [fsiId],
        );
        return result.rowCount;
      },
    );
    expect(rowsVisibleAcrossEntity).toBe(0);
  });

  it("rejects direct or invalid workflow mutations at the database layer", async () => {
    const projection = await withOrganizationScope(
      pool,
      { userId: blcsOperatorId, organizationIds: [blcsId] },
      async (client) => {
        const result = await client.query<{
          task_status: string;
          workflow_state: string;
        }>(
          `SELECT
             task.status AS task_status,
             workflow.current_state AS workflow_state
           FROM tasks task
           JOIN workflows workflow
             ON workflow.task_id = task.id
            AND workflow.organization_id = task.organization_id
           WHERE workflow.id = $1
             AND workflow.organization_id = $2`,
          [createdWorkflowId, blcsId],
        );
        return result.rows[0]!;
      },
    );
    expect(projection.task_status).toBe(projection.workflow_state);

    await expect(
      withOrganizationScope(
        pool,
        { userId: blcsOperatorId, organizationIds: [blcsId] },
        async (client) => {
          await client.query(
            `UPDATE workflows SET current_state = 'completed'
             WHERE id = $1 AND organization_id = $2`,
            [createdWorkflowId, blcsId],
          );
        },
      ),
    ).rejects.toThrow();

    await expect(
      withOrganizationScope(
        pool,
        { userId: blcsOperatorId, organizationIds: [blcsId] },
        async (client) => {
          await client.query(
            `SELECT *
             FROM transition_workflow(
               $1, $2, $3, 4, 'completed', 'user', $4, NULL, NULL, $5, '{}'::jsonb
             )`,
            [
              createdWorkflowId,
              blcsId,
              `invalid-${randomUUID()}`,
              blcsOperatorId,
              "trace-invalid-transition",
            ],
          );
        },
      ),
    ).rejects.toThrow();

    await expect(
      adminPool.query(
        `INSERT INTO operating_layer.workflow_transitions (
           workflow_id, organization_id, command_id, from_state, to_state,
           workflow_version, actor_type, actor_id, trace_id
         )
         VALUES ($1, $2, $3, 'awaiting_approval', 'completed', 99, 'user', $4, $5)`,
        [
          createdWorkflowId,
          blcsId,
          `direct-${randomUUID()}`,
          blcsOperatorId,
          "trace-direct-transition",
        ],
      ),
    ).rejects.toThrow();

    await expect(
      withOrganizationScope(
        pool,
        { userId: blcsOperatorId, organizationIds: [blcsId] },
        async (client) => {
          await client.query(
            `UPDATE tasks
             SET status = 'completed'
             WHERE id = $1
               AND organization_id = $2`,
            [createdTaskId, blcsId],
          );
        },
      ),
    ).rejects.toThrow();

    await expect(
      adminPool.query(
        `UPDATE operating_layer.tasks
         SET status = 'completed'
         WHERE id = $1
           AND organization_id = $2`,
        [createdTaskId, blcsId],
      ),
    ).rejects.toThrow(/transition_workflow/);
  });

  it("keeps audit history immutable and detects privileged payload tampering", async () => {
    const identifiers = await adminPool.query<{
      source_version_id: string;
      audit_event_id: string;
    }>(
      `SELECT
         (
           SELECT version.id
           FROM operating_layer.source_record_versions version
           JOIN operating_layer.task_source_records link
             ON link.source_record_id = version.source_record_id
           WHERE link.task_id = $1
           LIMIT 1
         ) AS source_version_id,
         (
           SELECT audit.id
           FROM operating_layer.audit_events audit
           WHERE audit.metadata ->> 'taskId' = $2
           LIMIT 1
         ) AS audit_event_id`,
      [createdTaskId, createdTaskId],
    );
    const row = identifiers.rows[0]!;
    await expect(
      adminPool.query(
        `UPDATE operating_layer.source_record_versions
         SET content_hash = repeat('0', 64)
         WHERE id = $1`,
        [row.source_version_id],
      ),
    ).rejects.toThrow();
    await expect(
      withOrganizationScope(
        pool,
        { userId: blcsOperatorId, organizationIds: [blcsId] },
        async (client) => {
          await client.query(
            `UPDATE audit_events
             SET event_type = 'tampered'
             WHERE id = $1`,
            [row.audit_event_id],
          );
        },
      ),
    ).rejects.toThrow();

    const untampered = await verifyAuditChain(adminPool, blcsId);
    expect(untampered.valid).toBe(true);
    expect(untampered.checkedEvents).toBeGreaterThanOrEqual(5);
    expect(untampered.errors).toEqual([]);

    const privilegedClient = await adminPool.connect();
    try {
      await privilegedClient.query("BEGIN");
      await privilegedClient.query(
        `ALTER TABLE operating_layer.audit_events
         DISABLE TRIGGER audit_events_are_immutable`,
      );
      await privilegedClient.query(
        `UPDATE operating_layer.audit_events
         SET metadata = metadata || '{"tampered": true}'::jsonb
         WHERE id = $1`,
        [row.audit_event_id],
      );

      const tampered = await verifyAuditChain(privilegedClient, blcsId);
      expect(tampered.valid).toBe(false);
      expect(tampered.errors).toContainEqual(
        expect.objectContaining({ code: "event_hash_mismatch" }),
      );
    } finally {
      await privilegedClient.query("ROLLBACK");
      privilegedClient.release();
    }

    await expect(verifyAuditChain(adminPool, blcsId)).resolves.toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("bounds retries, dead-letters exhausted work, and exposes it in the queue", async () => {
    const id = randomUUID();
    await withOrganizationScope(
      pool,
      { userId: blcsOperatorId, organizationIds: [blcsId] },
      async (client) => {
        await client.query(
          `INSERT INTO outbox_events (
             id,
             organization_id,
             topic,
             aggregate_type,
             aggregate_id,
             payload_reference,
             payload_hash,
             idempotency_key,
             trace_id,
             requested_by_user_id,
             request_id,
             max_attempts
           )
           VALUES (
             $1, $2, 'unsupported.test', 'workflow', $3, 'test://unsupported',
             repeat('a', 64), $4, 'trace-dead-letter', $5,
             'request-dead-letter', 2
           )`,
          [
            id,
            blcsId,
            createdWorkflowId,
            `unsupported-${randomUUID()}`,
            blcsOperatorId,
          ],
        );
      },
    );

    expect(await processNextOutboxJob(pool, "failure-test-worker")).toBe(
      "failed",
    );
    await withOrganizationScope(
      pool,
      { userId: blcsOperatorId, organizationIds: [blcsId] },
      async (client) => {
        await client.query(
          `UPDATE outbox_events
           SET available_at = now()
           WHERE id = $1
             AND organization_id = $2`,
          [id, blcsId],
        );
      },
    );
    expect(await processNextOutboxJob(pool, "failure-test-worker")).toBe(
      "dead_letter",
    );

    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": blcsOperatorEmail },
    });
    const body = queue.json<{
      counts: { failedJobs: number };
      jobFailures: Array<{ id: string; status: string; attempts: number }>;
    }>();
    expect(body.counts.failedJobs).toBeGreaterThanOrEqual(1);
    expect(body.jobFailures).toContainEqual(
      expect.objectContaining({
        id,
        status: "dead_letter",
        attempts: 2,
      }),
    );
  });

  it("retains idempotency results for seven days and reaps without racing replay", async () => {
    const idempotencyKey = `retention-${randomUUID()}`;
    const payload = {
      organizationId: blcsId,
      title: "Retention boundary test issue",
      description: "Create a controlled issue for idempotency retention proof.",
      retentionClassification: "operational",
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
        "x-trace-id": "trace-retention-first",
      },
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);
    const firstBody = first.json<{ taskId: string }>();

    const withinWindow = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
      },
      payload,
    });
    expect(withinWindow.statusCode).toBe(200);
    expect(withinWindow.json()).toMatchObject({
      taskId: firstBody.taskId,
      duplicate: true,
    });

    const retention = await adminPool.query<{
      retention_seconds_snapshot: number;
      retained_seconds: string;
    }>(
      `SELECT
         retention_seconds_snapshot,
         extract(epoch FROM (expires_at - terminal_at))::text
           AS retained_seconds
       FROM operating_layer.idempotency_keys
       WHERE organization_id = $1
         AND scope = 'manual_issue_intake'
         AND idempotency_key = $2`,
      [blcsId, idempotencyKey],
    );
    expect(retention.rows[0]).toMatchObject({
      retention_seconds_snapshot: 604800,
      retained_seconds: "604800.000000",
    });

    await adminPool.query(
      `UPDATE operating_layer.idempotency_keys
       SET
         terminal_at = now() - interval '8 days',
         expires_at = now() - interval '1 day'
       WHERE organization_id = $1
         AND scope = 'manual_issue_intake'
         AND idempotency_key = $2`,
      [blcsId, idempotencyKey],
    );

    const replayLock = await pool.connect();
    try {
      await replayLock.query("BEGIN");
      await replayLock.query("SET LOCAL ROLE operating_layer_app");
      await replayLock.query(
        "SELECT set_config('app.organization_ids', $1, true)",
        [`{${blcsId}}`],
      );
      await replayLock.query("SELECT set_config('app.user_id', $1, true)", [
        blcsOperatorId,
      ]);
      await replayLock.query(
        "SET LOCAL search_path TO operating_layer, public",
      );
      await replayLock.query(
        `SELECT idempotency_key
         FROM idempotency_keys
         WHERE organization_id = $1
           AND scope = 'manual_issue_intake'
           AND idempotency_key = $2
         FOR UPDATE`,
        [blcsId, idempotencyKey],
      );

      const skipped = await reapExpiredIdempotencyKeys(
        pool,
        "trace-reaper-skips-replay-lock",
      );
      expect(skipped.deletedCount).toBe(0);
    } finally {
      await replayLock.query("ROLLBACK");
      replayLock.release();
    }

    const reaped = await reapExpiredIdempotencyKeys(
      pool,
      "trace-reaper-expired",
    );
    expect(reaped.deletedCount).toBe(1);

    const afterExpiry = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": idempotencyKey,
        "x-trace-id": "trace-retention-new-intent",
      },
      payload,
    });
    expect(afterExpiry.statusCode, afterExpiry.body).toBe(202);
    expect(afterExpiry.json()).toMatchObject({
      duplicate: false,
    });
    expect(afterExpiry.json<{ taskId: string }>().taskId).not.toBe(
      firstBody.taskId,
    );
  });

  it("enforces two-person policy activation, permits one-person revert, and audits changes", async () => {
    const adminPrincipal = await resolveApplicationPrincipal(pool, {
      issuer: "local",
      subject: "test-admin",
      email: adminEmail,
    });
    const executivePrincipal = await resolveApplicationPrincipal(pool, {
      issuer: "local",
      subject: "test-executive",
      email: executiveEmail,
    });
    const activeV1 = await withOrganizationScope(
      pool,
      { userId: adminPrincipal.userId, organizationIds: [blcsId] },
      (client) => loadActiveApprovalPolicy(client, blcsId),
    );
    const ruleDrafts = activeV1.rules.map(({ id: _ignored, ...rule }) => rule);
    const v2 = await createApprovalPolicyVersion(pool, {
      principal: adminPrincipal,
      organizationId: blcsId,
      versionNumber: 2,
      humanLabel: "phase1-v1-data-test-v2",
      description: "Behavior-equivalent activation-control fixture",
      supersedesVersionId: activeV1.id,
      rules: ruleDrafts,
    });
    const request = await requestApprovalPolicyActivation(pool, {
      principal: adminPrincipal,
      organizationId: blcsId,
      policyVersionId: v2.policyVersionId,
      reason: "Exercise two-person activation",
      commandId: `request-v2-${randomUUID()}`,
      context: {
        traceId: "trace-policy-request-v2",
        requestId: "request-policy-v2",
      },
    });

    await expect(
      activateApprovalPolicy(pool, {
        principal: adminPrincipal,
        organizationId: blcsId,
        policyVersionId: v2.policyVersionId,
        activationRequestId: request.activationRequestId,
        reason: "Author cannot self-activate",
        commandId: `activate-self-${randomUUID()}`,
        context: {
          traceId: "trace-policy-self-activate",
          requestId: "request-policy-self-activate",
        },
      }),
    ).rejects.toThrow(/two distinct actors|author cannot activate/);

    const v3 = await createApprovalPolicyVersion(pool, {
      principal: adminPrincipal,
      organizationId: blcsId,
      versionNumber: 3,
      humanLabel: "phase1-v1-data-test-v3",
      description: "Single-actor activation rejection fixture",
      supersedesVersionId: v2.policyVersionId,
      rules: ruleDrafts,
    });
    await expect(
      activateApprovalPolicy(pool, {
        principal: executivePrincipal,
        organizationId: blcsId,
        policyVersionId: v3.policyVersionId,
        reason: "Missing second-actor request must fail",
        commandId: `activate-no-request-${randomUUID()}`,
        context: {
          traceId: "trace-policy-no-request",
          requestId: "request-policy-no-request",
        },
      }),
    ).rejects.toThrow(/second-actor request/);

    const activated = await activateApprovalPolicy(pool, {
      principal: executivePrincipal,
      organizationId: blcsId,
      policyVersionId: v2.policyVersionId,
      activationRequestId: request.activationRequestId,
      reason: "Second actor approves behavior-equivalent version",
      commandId: `activate-v2-${randomUUID()}`,
      context: {
        traceId: "trace-policy-activate-v2",
        requestId: "request-policy-activate-v2",
      },
    });
    expect(activated).toMatchObject({
      activatedPolicyVersionId: v2.policyVersionId,
      previousPolicyVersionId: activeV1.id,
      activationMode: "new_version",
      bindingVersion: 2,
    });

    const activationAudit = await adminPool.query<{
      trace_id: string;
      activation_id: string;
    }>(
      `SELECT
         trace_id,
         metadata ->> 'activationId' AS activation_id
       FROM operating_layer.audit_events
       WHERE organization_id = $1
         AND event_type = 'approval_policy.activated'
         AND metadata ->> 'activationId' = $2`,
      [blcsId, activated.activationId],
    );
    expect(activationAudit.rows[0]).toEqual({
      trace_id: "trace-policy-activate-v2",
      activation_id: activated.activationId,
    });

    const reverted = await activateApprovalPolicy(pool, {
      principal: executivePrincipal,
      organizationId: blcsId,
      policyVersionId: activeV1.id,
      reason: "Break-glass restore of previously approved policy",
      commandId: `revert-v1-${randomUUID()}`,
      context: {
        traceId: "trace-policy-revert-v1",
        requestId: "request-policy-revert-v1",
      },
    });
    expect(reverted).toMatchObject({
      activatedPolicyVersionId: activeV1.id,
      previousPolicyVersionId: v2.policyVersionId,
      activationMode: "revert",
      bindingVersion: 3,
    });
  });

  it("approves once, reaches terminal state, removes pending work, and preserves the root trace", async () => {
    const crossOrgApi = await app.inject({
      method: "POST",
      url: `/v1/approvals/${createdApprovalId}/resolution`,
      headers: {
        "x-dev-user-email": fsiOperatorEmail,
        "idempotency-key": `cross-org-${randomUUID()}`,
      },
      payload: {
        organizationId: blcsId,
        decision: "approved",
        reason: "Unauthorized cross-organization attempt",
      },
    });
    expect(crossOrgApi.statusCode).toBe(403);

    const crossOrgRows = await withOrganizationScope(
      pool,
      {
        userId: "20000000-0000-4000-8000-000000000004",
        organizationIds: [fsiId],
      },
      async (client) => {
        const result = await client.query(
          `SELECT id
           FROM approvals
           WHERE id = $1`,
          [createdApprovalId],
        );
        return result.rowCount;
      },
    );
    expect(crossOrgRows).toBe(0);

    const idempotencyKey = `approve-${randomUUID()}`;
    const approved = await app.inject({
      method: "POST",
      url: `/v1/approvals/${createdApprovalId}/resolution`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": idempotencyKey,
        "x-trace-id": "trace-approval-http-request",
      },
      payload: {
        organizationId: blcsId,
        decision: "approved",
        reason: "Facts and cited balance support the internal next step.",
      },
    });
    expect(approved.statusCode, approved.body).toBe(202);
    const approvedBody = approved.json<{
      resolutionId: string;
      workflowState: string;
      duplicate: boolean;
      traceId: string;
      policyVersionId: string;
    }>();
    expect(approvedBody).toMatchObject({
      workflowState: "completed",
      duplicate: false,
      traceId: "trace-feature-intake",
      policyVersionId: "62000000-0000-4000-8000-000000000001",
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/approvals/${createdApprovalId}/resolution`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        organizationId: blcsId,
        decision: "approved",
        reason: "Facts and cited balance support the internal next step.",
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      resolutionId: approvedBody.resolutionId,
      duplicate: true,
      workflowState: "completed",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${createdTaskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": approverEmail },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<{
      task: { status: string };
      workflows: Array<{
        current_state: string;
        approval_status: string;
      }>;
      approvals: Array<{
        status: string;
        decision_reason: string;
        decided_by_user_id: string;
      }>;
      approvalResolutions: Array<{
        id: string;
        decision: string;
        reason: string;
        resolver_name: string;
        resulting_workflow_state: string;
        trace_id: string;
      }>;
      auditHistory: Array<{
        eventType: string;
        traceId: string;
        metadata: { resolutionId?: string };
      }>;
    }>();
    expect(detailBody.task.status).toBe("completed");
    expect(detailBody.workflows[0]).toMatchObject({
      current_state: "completed",
      approval_status: "approved",
    });
    expect(detailBody.approvals[0]).toMatchObject({
      status: "approved",
      decided_by_user_id: "20000000-0000-4000-8000-000000000005",
    });
    expect(detailBody.approvalResolutions).toContainEqual(
      expect.objectContaining({
        id: approvedBody.resolutionId,
        decision: "approved",
        resulting_workflow_state: "completed",
        trace_id: "trace-feature-intake",
      }),
    );
    const resolutionAudits = detailBody.auditHistory.filter(
      (event) =>
        event.eventType === "approval.approved" &&
        event.metadata.resolutionId === approvedBody.resolutionId,
    );
    expect(resolutionAudits).toHaveLength(1);
    expect(resolutionAudits[0]?.traceId).toBe("trace-feature-intake");

    const queue = await app.inject({
      method: "GET",
      url: `/v1/executive-queue?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": approverEmail },
    });
    const queueBody = queue.json<{
      tasks: Array<{ id: string }>;
      approvalPending: Array<{ id: string }>;
      recentResolutions: Array<{ id: string; decision: string }>;
    }>();
    expect(queueBody.tasks.map((task) => task.id)).not.toContain(createdTaskId);
    expect(queueBody.approvalPending).toHaveLength(0);
    expect(queueBody.recentResolutions).toContainEqual(
      expect.objectContaining({
        id: approvedBody.resolutionId,
        decision: "approved",
      }),
    );

    await expect(
      withOrganizationScope(
        pool,
        { userId: blcsOperatorId, organizationIds: [blcsId] },
        async (client) => {
          await client.query(
            `SELECT *
             FROM transition_workflow(
               $1, $2, $3, 7, 'rejected', 'user', $4, NULL, NULL, $5,
               '{}'::jsonb
             )`,
            [
              createdWorkflowId,
              blcsId,
              `illegal-after-terminal-${randomUUID()}`,
              blcsOperatorId,
              "trace-illegal-after-terminal",
            ],
          );
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects once and reaches the rejected terminal state", async () => {
    const intakeKey = `reject-intake-${randomUUID()}`;
    const intakeTrace = "trace-feature-reject";
    const intake = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": blcsOperatorEmail,
        "idempotency-key": intakeKey,
        "x-trace-id": intakeTrace,
      },
      payload: {
        organizationId: blcsId,
        title: "Customer escalation requires rejection proof",
        description:
          "A $80,000 receivable needs an external customer follow-up draft.",
        financialExposure: 80_000,
        financialExposureCurrency: "USD",
        retentionClassification: "financial_support",
      },
    });
    expect(intake.statusCode, intake.body).toBe(202);
    const taskId = intake.json<{ taskId: string }>().taskId;
    const rejectedDrain = await drainOutbox(pool, "reject-test-worker");
    expect(rejectedDrain.failed).toBe(0);
    expect(rejectedDrain.published).toBeGreaterThanOrEqual(2);
    const before = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": approverEmail },
    });
    const approvalId = before.json<{
      approvals: Array<{ id: string }>;
    }>().approvals[0]!.id;

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolution`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `reject-${randomUUID()}`,
      },
      payload: {
        organizationId: blcsId,
        decision: "rejected",
        reason:
          "The cited record does not support contacting the customer yet.",
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(202);
    expect(rejected.json()).toMatchObject({
      decision: "rejected",
      workflowState: "rejected",
      traceId: intakeTrace,
    });

    const after = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": approverEmail },
    });
    expect(after.json()).toMatchObject({
      task: { status: "rejected" },
      workflows: [
        {
          current_state: "rejected",
          approval_status: "rejected",
        },
      ],
      approvals: [
        {
          status: "rejected",
        },
      ],
      approvalResolutions: [
        {
          decision: "rejected",
          resulting_workflow_state: "rejected",
          trace_id: intakeTrace,
        },
      ],
    });
  });
});
