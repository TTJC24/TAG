import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevelopmentHeaderIdentityProvider } from "@operating-layer/auth";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
  type DatabasePool,
} from "@operating-layer/db";
import { DeterministicInternalExecutionProvider } from "@operating-layer/executors";
import {
  drainOutbox,
  processNextOutboxJob,
} from "@operating-layer/issue-intake";
import { buildApi } from "./server.js";

const blcsId = "10000000-0000-4000-8000-000000000001";
const fsiId = "10000000-0000-4000-8000-000000000002";
const operatorEmail = "operator@local.operating-layer";
const approverEmail = "approver@local.operating-layer";
const adminEmail = "admin@local.operating-layer";

describe("operator dead-letter replay of internal execution", () => {
  let adminPool: DatabasePool;
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildApi>>;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL_TEST;
    const runtimeDatabaseUrl = process.env.DATABASE_URL_RUNTIME_TEST;
    if (!databaseUrl || !runtimeDatabaseUrl) {
      throw new Error(
        "DATABASE_URL_TEST and DATABASE_URL_RUNTIME_TEST required",
      );
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

  async function createApprovedFixture(trace: string): Promise<{
    taskId: string;
    approvalId: string;
  }> {
    const intake = await app.inject({
      method: "POST",
      url: "/v1/issues",
      headers: {
        "x-dev-user-email": operatorEmail,
        "idempotency-key": `replay-intake-${randomUUID()}`,
        "x-trace-id": trace,
      },
      payload: {
        organizationId: blcsId,
        title: "Replay fixture: internal follow-up on overdue receivable",
        description:
          "A $90,000 receivable requires an approved internal follow-up outcome.",
        financialExposure: 90_000,
        financialExposureCurrency: "USD",
        retentionClassification: "financial_support",
      },
    });
    expect(intake.statusCode, intake.body).toBe(202);
    const taskId = intake.json<{ taskId: string }>().taskId;
    const prepared = await drainOutbox(pool, "replay-prep-worker");
    expect(prepared.failed).toBe(0);
    expect(prepared.deadLetter).toBe(0);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": approverEmail },
    });
    const approvalId = detail.json<{ approvals: Array<{ id: string }> }>()
      .approvals[0]!.id;

    const approval = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/resolution`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `replay-approve-${randomUUID()}`,
      },
      payload: {
        organizationId: blcsId,
        decision: "approved",
        reason: "Approve the replay fixture for execution.",
      },
    });
    expect(approval.statusCode, approval.body).toBe(202);
    return { taskId, approvalId };
  }

  async function driveToDeadLetter(
    approvalId: string,
    trace: string,
  ): Promise<{ executionCommandId: string; outboxEventId: string }> {
    const trigger = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `replay-trigger-${randomUUID()}`,
        "x-trace-id": trace,
      },
      payload: { organizationId: blcsId },
    });
    expect(trigger.statusCode, trigger.body).toBe(202);
    const body = trigger.json<{
      executionCommandId: string;
      outboxEventId: string;
    }>();

    const failing = new DeterministicInternalExecutionProvider({
      outcome: "failed",
      failureCode: "deterministic_fixture_failure",
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const status = await processNextOutboxJob(
        pool,
        "replay-fail-worker",
        failing,
      );
      expect(status).toBe(attempt < 2 ? "failed" : "dead_letter");
      await adminPool.query(
        `UPDATE operating_layer.outbox_events SET available_at = now() WHERE id = $1`,
        [body.outboxEventId],
      );
    }
    return body;
  }

  it("replays a dead-lettered execution to completion with a fresh immutable command", async () => {
    const trace = "trace-replay-happy";
    const { taskId, approvalId } = await createApprovedFixture(trace);
    const { executionCommandId, outboxEventId } = await driveToDeadLetter(
      approvalId,
      trace,
    );

    // Unauthorized: an approver without executions.replay cannot replay.
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": approverEmail,
        "idempotency-key": `replay-forbidden-${randomUUID()}`,
      },
      payload: { organizationId: blcsId },
    });
    expect(forbidden.statusCode, forbidden.body).toBe(403);

    // Authorized replay by an operator with executions.replay.
    const replayKey = `replay-${randomUUID()}`;
    const replay = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": replayKey,
        "x-trace-id": "trace-replay-request-http",
      },
      payload: { organizationId: blcsId },
    });
    expect(replay.statusCode, replay.body).toBe(202);
    const replayBody = replay.json<{
      executionReplayId: string;
      executionCommandId: string;
      originalExecutionCommandId: string;
      deadLetterEventId: string;
      status: string;
      duplicate: boolean;
      traceId: string;
    }>();
    expect(replayBody.status).toBe("queued");
    expect(replayBody.duplicate).toBe(false);
    expect(replayBody.originalExecutionCommandId).toBe(executionCommandId);
    expect(replayBody.deadLetterEventId).toBe(outboxEventId);
    expect(replayBody.executionCommandId).not.toBe(executionCommandId);
    expect(replayBody.traceId).toBe(trace); // trace continuity to the origin

    // Idempotent: the same key replays the stored result, no new command.
    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": replayKey,
      },
      payload: { organizationId: blcsId },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      executionReplayId: replayBody.executionReplayId,
      executionCommandId: replayBody.executionCommandId,
      duplicate: true,
    });

    // The worker drives the replayed command to completion.
    expect(await processNextOutboxJob(pool, "replay-success-worker")).toBe(
      "published",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}?organizationId=${blcsId}`,
      headers: { "x-dev-user-email": adminEmail },
    });
    const detailBody = detail.json<{
      task: { status: string };
      workflows: Array<{ current_state: string }>;
      executionResults: Array<{
        execution_command_id: string;
        outcome: string;
        resulting_workflow_state: string;
      }>;
      auditHistory: Array<{
        eventType: string;
        traceId: string;
        metadata: Record<string, unknown>;
      }>;
    }>();
    expect(detailBody.task.status).toBe("completed");
    expect(detailBody.workflows[0]).toMatchObject({
      current_state: "completed",
    });

    // The original failed result is immutable and preserved; a new succeeded
    // result exists for the fresh replay command.
    const original = detailBody.executionResults.find(
      (result) => result.execution_command_id === executionCommandId,
    );
    const replayed = detailBody.executionResults.find(
      (result) => result.execution_command_id === replayBody.executionCommandId,
    );
    expect(original).toMatchObject({
      outcome: "failed",
      resulting_workflow_state: "execution_failed",
    });
    expect(replayed).toMatchObject({
      outcome: "succeeded",
      resulting_workflow_state: "completed",
    });

    // The replay is audited with trace continuity.
    const replayAudit = detailBody.auditHistory.find(
      (event) =>
        event.eventType === "execution.replay_requested" &&
        event.metadata.executionReplayId === replayBody.executionReplayId,
    );
    expect(replayAudit).toBeDefined();
    expect(replayAudit!.traceId).toBe(trace);
    expect(replayAudit!.metadata).toMatchObject({
      originalExecutionCommandId: executionCommandId,
      executionCommandId: replayBody.executionCommandId,
      deadLetterEventId: outboxEventId,
    });

    // An immutable replay-linkage row was recorded.
    const linkage = await adminPool.query(
      `SELECT original_execution_command_id, replay_execution_command_id,
              dead_letter_event_id
       FROM operating_layer.execution_replays
       WHERE id = $1 AND organization_id = $2`,
      [replayBody.executionReplayId, blcsId],
    );
    expect(linkage.rows[0]).toMatchObject({
      original_execution_command_id: executionCommandId,
      replay_execution_command_id: replayBody.executionCommandId,
      dead_letter_event_id: outboxEventId,
    });

    // The original dead-letter job remains as history, untouched.
    const deadLetter = await adminPool.query<{ status: string }>(
      `SELECT status FROM operating_layer.outbox_events WHERE id = $1`,
      [outboxEventId],
    );
    expect(deadLetter.rows[0]!.status).toBe("dead_letter");

    // Once completed, a further replay is rejected: the state is not failed.
    const afterCompletion = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `replay-again-${randomUUID()}`,
      },
      payload: { organizationId: blcsId },
    });
    expect(afterCompletion.statusCode).toBe(409);
  });

  it("rejects replay of an execution that has not failed", async () => {
    const { approvalId } = await createApprovedFixture(
      "trace-replay-notfailed",
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `replay-notfailed-${randomUUID()}`,
      },
      payload: { organizationId: blcsId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "execution_not_failed" });
  });

  it("does not leak another organization's approval across the org boundary", async () => {
    const { approvalId } = await createApprovedFixture("trace-replay-crossorg");
    // admin is a member of FS too, so the permission check passes for fsiId,
    // but the blcs approval must not be visible under the FS scope.
    const response = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/executions/replay`,
      headers: {
        "x-dev-user-email": adminEmail,
        "idempotency-key": `replay-crossorg-${randomUUID()}`,
      },
      payload: { organizationId: fsiId },
    });
    expect(response.statusCode).toBe(404);
  });
});
