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
  drainOutbox,
  processNextOutboxJob,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const blcsId = "10000000-0000-4000-8000-000000000001";
const fsiId = "10000000-0000-4000-8000-000000000002";
const blcsOperatorId = "20000000-0000-4000-8000-000000000003";
const blcsOperatorEmail = "operator@local.operating-layer";
const fsiOperatorEmail = "fsi-operator@local.operating-layer";

describe("Phase 1 manual issue vertical slice", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;
  let createdTaskId: string;
  let createdWorkflowId: string;

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
      approvals: Array<{ status: string }>;
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
});
