import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  canonicalJson,
  sha256,
} from "@operating-layer/audit";
import {
  withOrganizationScope,
  type DatabaseClient,
  type DatabasePool,
} from "@operating-layer/db";
import type { AgentContext } from "@operating-layer/agents";
import { evaluateApprovalPolicy } from "@operating-layer/workflows";
import {
  ClassificationAgent,
  DeterministicModelProvider,
  RecommendationAgent,
} from "./agents.js";

interface OutboxJob {
  id: string;
  organization_id: string;
  topic: string;
  aggregate_id: string;
  idempotency_key: string;
  trace_id: string;
  requested_by_user_id: string;
  request_id: string;
  attempts: number;
  max_attempts: number;
}

interface WorkflowTaskRow {
  workflow_id: string;
  workflow_state: string;
  workflow_version: number;
  task_id: string;
  title: string;
  description: string;
  task_type: string;
  priority: "P0" | "P1" | "P2" | "P3";
  financial_exposure: string | null;
  created_by_actor_id: string;
  organization_code: "BLCS" | "FSI" | "USA" | "CULTIVUS";
  source_record_id: string;
  source_version_id: string;
  content_hash: string;
  observed_at: Date | string;
}

const provider = new DeterministicModelProvider();
const classificationAgent = new ClassificationAgent(provider);
const recommendationAgent = new RecommendationAgent(provider);

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function agentContext(
  job: OutboxJob,
  promptVersionId: string,
  citation: {
    sourceRecordId: string;
    sourceRecordVersionId: string;
    locator: string;
    excerptHash: string;
    observedAt: string;
  },
): AgentContext {
  return {
    traceId: job.trace_id,
    organizationId: job.organization_id,
    actorId: job.requested_by_user_id,
    promptVersionId,
    modelRoute: {
      provider: "deterministic",
      model: "deterministic-rules-v1",
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    },
    sourceCitations: [citation],
  };
}

async function loadWorkflowTask(
  client: DatabaseClient,
  job: OutboxJob,
): Promise<WorkflowTaskRow> {
  const result = await client.query<WorkflowTaskRow>(
    `SELECT
       workflow.id AS workflow_id,
       workflow.current_state AS workflow_state,
       workflow.version AS workflow_version,
       task.id AS task_id,
       task.title,
       task.description,
       task.task_type,
       task.priority,
       task.financial_exposure,
       task.created_by_actor_id,
       organization.code AS organization_code,
       source.id AS source_record_id,
       version.id AS source_version_id,
       version.content_hash,
       version.observed_at
     FROM workflows workflow
     JOIN tasks task
       ON task.id = workflow.task_id
      AND task.organization_id = workflow.organization_id
     JOIN organizations organization
       ON organization.id = workflow.organization_id
     JOIN task_source_records task_source
       ON task_source.task_id = task.id
      AND task_source.organization_id = task.organization_id
     JOIN source_records source
       ON source.id = task_source.source_record_id
      AND source.organization_id = task_source.organization_id
     JOIN source_record_versions version
       ON version.id = source.latest_version_id
      AND version.organization_id = source.organization_id
     WHERE workflow.id = $1
       AND workflow.organization_id = $2
     ORDER BY version.observed_at DESC
     LIMIT 1`,
    [job.aggregate_id, job.organization_id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Workflow task or source version was not found");
  }
  return row;
}

async function transition(
  client: DatabaseClient,
  job: OutboxJob,
  workflow: WorkflowTaskRow,
  expectedVersion: number,
  toState: string,
  commandSuffix: string,
  input: unknown,
  output: unknown,
): Promise<number> {
  const result = await client.query<{ workflow_version: number }>(
    `SELECT workflow_version
     FROM transition_workflow(
       $1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10::jsonb
     )`,
    [
      workflow.workflow_id,
      job.organization_id,
      `${job.idempotency_key}:${commandSuffix}`,
      expectedVersion,
      toState,
      job.requested_by_user_id,
      sha256(input),
      sha256(output),
      job.trace_id,
      JSON.stringify({ taskId: workflow.task_id, outboxEventId: job.id }),
    ],
  );
  const nextVersion = result.rows[0]?.workflow_version;
  if (!nextVersion) {
    throw new Error("Workflow transition did not return a version");
  }
  return nextVersion;
}

async function processClassification(
  client: DatabaseClient,
  job: OutboxJob,
): Promise<void> {
  const workflow = await loadWorkflowTask(client, job);
  if (workflow.workflow_state !== "normalized") {
    await client.query(
      `UPDATE outbox_events
       SET status = 'published', published_at = now(), locked_at = NULL,
           locked_by = NULL
       WHERE id = $1 AND organization_id = $2`,
      [job.id, job.organization_id],
    );
    return;
  }

  const citation = {
    sourceRecordId: workflow.source_record_id,
    sourceRecordVersionId: workflow.source_version_id,
    locator: "manual_issue.input",
    excerptHash: workflow.content_hash,
    observedAt: toIso(workflow.observed_at),
  };
  const context = agentContext(
    job,
    "50000000-0000-4000-8000-000000000001",
    citation,
  );
  const financialExposure =
    workflow.financial_exposure === null
      ? undefined
      : Number(workflow.financial_exposure);
  const result = await classificationAgent.run(context, {
    entityCode: workflow.organization_code,
    title: workflow.title,
    description: workflow.description,
    ...(financialExposure !== undefined ? { financialExposure } : {}),
    createdByUserId: workflow.created_by_actor_id,
    citation,
  });
  const inputHash = sha256({
    taskId: workflow.task_id,
    sourceVersionId: workflow.source_version_id,
  });
  const outputHash = sha256(result.output);
  const agentRunId = randomUUID();

  await client.query(
    `INSERT INTO agent_runs (
       id,
       organization_id,
       workflow_id,
       task_id,
       agent_kind,
       prompt_version_id,
       provider,
       model,
       status,
       input_hash,
       output_hash,
       reasoning_summary,
       confidence,
       risk_level,
       input_tokens,
       output_tokens,
       cost_usd,
       latency_ms,
       trace_id,
       started_at,
       completed_at
     )
     VALUES (
       $1, $2, $3, $4, 'classification', $5, $6, $7, 'succeeded', $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, now(), now()
     )`,
    [
      agentRunId,
      job.organization_id,
      workflow.workflow_id,
      workflow.task_id,
      context.promptVersionId,
      result.provider,
      result.model,
      inputHash,
      outputHash,
      result.decisionSummary,
      result.confidence,
      result.riskLevel,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.costUsd,
      result.usage.latencyMs,
      job.trace_id,
    ],
  );

  await client.query(
    `UPDATE tasks
     SET
       task_type = $3,
       priority = $4,
       owner_user_id = COALESCE($5, owner_user_id),
       confidence = $6,
       updated_at = now(),
       version = version + 1
     WHERE id = $1 AND organization_id = $2`,
    [
      workflow.task_id,
      job.organization_id,
      result.output.taskType,
      result.output.priority,
      result.output.suggestedOwnerUserId,
      result.output.confidence,
    ],
  );

  const nextVersion = await transition(
    client,
    job,
    workflow,
    workflow.workflow_version,
    "classified",
    "classified",
    { inputHash },
    result.output,
  );

  await appendAuditEvent(client, {
    organizationId: job.organization_id,
    actorType: "agent",
    actorId: "deterministic-classification-v1",
    eventType: "task.classified",
    workflowId: workflow.workflow_id,
    sourceRecordIds: [workflow.source_record_id],
    inputHash,
    outputHash,
    traceId: job.trace_id,
    requestId: job.request_id,
    metadata: {
      taskId: workflow.task_id,
      agentRunId,
      promptVersionId: context.promptVersionId,
      model: result.model,
      confidence: result.confidence,
      decisionSummary: result.decisionSummary,
      workflowVersion: nextVersion,
    },
    occurredAt: new Date().toISOString(),
  });

  await client.query(
    `INSERT INTO outbox_events (
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
       $1, 'issue.recommend', 'workflow', $2, $3, $4, $5, $6, $7, $8, 3
     )
     ON CONFLICT (organization_id, topic, idempotency_key) DO NOTHING`,
    [
      job.organization_id,
      workflow.workflow_id,
      `postgresql://operating_layer/workflows/${workflow.workflow_id}`,
      sha256({ workflowId: workflow.workflow_id, command: "recommend" }),
      `${job.idempotency_key}:recommend`,
      job.trace_id,
      job.requested_by_user_id,
      job.request_id,
    ],
  );

  await client.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), locked_at = NULL,
         locked_by = NULL, safe_error_message = NULL, last_error_code = NULL
     WHERE id = $1 AND organization_id = $2`,
    [job.id, job.organization_id],
  );
}

async function processRecommendation(
  client: DatabaseClient,
  job: OutboxJob,
): Promise<void> {
  const workflow = await loadWorkflowTask(client, job);
  if (workflow.workflow_state !== "classified") {
    await client.query(
      `UPDATE outbox_events
       SET status = 'published', published_at = now(), locked_at = NULL,
           locked_by = NULL
       WHERE id = $1 AND organization_id = $2`,
      [job.id, job.organization_id],
    );
    return;
  }

  const citation = {
    sourceRecordId: workflow.source_record_id,
    sourceRecordVersionId: workflow.source_version_id,
    locator: "manual_issue.input",
    excerptHash: workflow.content_hash,
    observedAt: toIso(workflow.observed_at),
  };
  const context = agentContext(
    job,
    "50000000-0000-4000-8000-000000000002",
    citation,
  );
  const financialExposure =
    workflow.financial_exposure === null
      ? undefined
      : Number(workflow.financial_exposure);
  const result = await recommendationAgent.run(context, {
    title: workflow.title,
    description: workflow.description,
    taskType: workflow.task_type,
    priority: workflow.priority,
    ...(financialExposure !== undefined ? { financialExposure } : {}),
    citation,
  });
  const policy = evaluateApprovalPolicy({
    riskLevel: result.output.riskLevel,
    requestedAction: result.output.recommendationType,
  });
  if (!policy.allowedInPhase && result.output.riskLevel >= 5) {
    throw new Error(
      `Recommendation requires a prohibited Phase 1 capability: ${policy.reasonCode}`,
    );
  }

  const inputHash = sha256({
    taskId: workflow.task_id,
    classification: workflow.task_type,
    sourceVersionId: workflow.source_version_id,
  });
  const outputHash = sha256(result.output);
  const agentRunId = randomUUID();
  const recommendationId = randomUUID();

  await client.query(
    `INSERT INTO agent_runs (
       id,
       organization_id,
       workflow_id,
       task_id,
       agent_kind,
       prompt_version_id,
       provider,
       model,
       status,
       input_hash,
       output_hash,
       reasoning_summary,
       confidence,
       risk_level,
       input_tokens,
       output_tokens,
       cost_usd,
       latency_ms,
       trace_id,
       started_at,
       completed_at
     )
     VALUES (
       $1, $2, $3, $4, 'recommendation', $5, $6, $7, 'succeeded', $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, now(), now()
     )`,
    [
      agentRunId,
      job.organization_id,
      workflow.workflow_id,
      workflow.task_id,
      context.promptVersionId,
      result.provider,
      result.model,
      inputHash,
      outputHash,
      result.decisionSummary,
      result.confidence,
      result.riskLevel,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.costUsd,
      result.usage.latencyMs,
      job.trace_id,
    ],
  );

  await client.query(
    `INSERT INTO recommendations (
       id,
       organization_id,
       task_id,
       recommendation_type,
       summary,
       reasoning_summary,
       confidence,
       risk_level,
       requires_approval,
       status,
       agent_run_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposed', $10)`,
    [
      recommendationId,
      job.organization_id,
      workflow.task_id,
      result.output.recommendationType,
      result.output.summary,
      result.output.decisionSummary,
      result.output.confidence,
      result.output.riskLevel,
      policy.requiresApproval,
      agentRunId,
    ],
  );

  await client.query(
    `INSERT INTO recommendation_sources (
       organization_id,
       recommendation_id,
       source_record_id,
       source_record_version_id,
       locator,
       excerpt_hash
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      job.organization_id,
      recommendationId,
      citation.sourceRecordId,
      citation.sourceRecordVersionId,
      citation.locator,
      citation.excerptHash,
    ],
  );

  let workflowVersion = await transition(
    client,
    job,
    workflow,
    workflow.workflow_version,
    "recommended",
    "recommended",
    { inputHash },
    result.output,
  );

  await appendAuditEvent(client, {
    organizationId: job.organization_id,
    actorType: "agent",
    actorId: "deterministic-recommendation-v1",
    eventType: "recommendation.created",
    workflowId: workflow.workflow_id,
    sourceRecordIds: [workflow.source_record_id],
    inputHash,
    outputHash,
    traceId: job.trace_id,
    requestId: job.request_id,
    metadata: {
      taskId: workflow.task_id,
      recommendationId,
      agentRunId,
      promptVersionId: context.promptVersionId,
      model: result.model,
      confidence: result.confidence,
      riskLevel: result.riskLevel,
      decisionSummary: result.decisionSummary,
      workflowVersion,
    },
    occurredAt: new Date().toISOString(),
  });

  if (policy.requiresApproval) {
    const approverResult = await client.query<{ user_id: string }>(
      `SELECT membership.user_id
       FROM organization_memberships membership
       JOIN permission_set_grants grant_row
         ON grant_row.permission_set_id = membership.permission_set_id
       JOIN users approver ON approver.id = membership.user_id
       WHERE membership.organization_id = $1
         AND membership.status = 'active'
         AND approver.status = 'active'
         AND grant_row.permission = 'approvals.decide'
       ORDER BY membership.created_at
       LIMIT 1`,
      [job.organization_id],
    );
    const approverUserId = approverResult.rows[0]?.user_id;
    if (!approverUserId) {
      throw new Error("No active approver is configured");
    }

    await client.query(
      `INSERT INTO approvals (
         organization_id,
         workflow_id,
         requested_from_user_id,
         requested_by_actor_type,
         requested_by_actor_id,
         action_type,
         target_reference,
         payload_reference,
         payload_hash,
         policy_version,
         risk_level,
         status
       )
       VALUES (
         $1, $2, $3, 'agent', 'deterministic-recommendation-v1', $4, $5,
         $6, $7, $8, $9, 'pending'
       )`,
      [
        job.organization_id,
        workflow.workflow_id,
        approverUserId,
        result.output.recommendationType,
        `task:${workflow.task_id}`,
        `recommendation:${recommendationId}`,
        outputHash,
        policy.policyVersion,
        result.output.riskLevel,
      ],
    );
    workflowVersion = await transition(
      client,
      job,
      workflow,
      workflowVersion,
      "awaiting_approval",
      "approval-required",
      result.output,
      policy,
    );
  } else {
    workflowVersion = await transition(
      client,
      job,
      workflow,
      workflowVersion,
      "completed",
      "approval-not-required",
      result.output,
      policy,
    );
  }

  await appendAuditEvent(client, {
    organizationId: job.organization_id,
    actorType: "system",
    actorId: "approval-policy:phase1-v1",
    eventType: policy.requiresApproval
      ? "approval.required"
      : "approval.not_required",
    workflowId: workflow.workflow_id,
    sourceRecordIds: [workflow.source_record_id],
    inputHash: outputHash,
    outputHash: sha256(policy),
    traceId: job.trace_id,
    requestId: job.request_id,
    metadata: {
      taskId: workflow.task_id,
      recommendationId,
      policyVersion: policy.policyVersion,
      reasonCode: policy.reasonCode,
      workflowVersion,
    },
    occurredAt: new Date().toISOString(),
  });

  await client.query(
    `UPDATE outbox_events
     SET status = 'published', published_at = now(), locked_at = NULL,
         locked_by = NULL, safe_error_message = NULL, last_error_code = NULL
     WHERE id = $1 AND organization_id = $2`,
    [job.id, job.organization_id],
  );
}

async function dispatchJob(
  client: DatabaseClient,
  job: OutboxJob,
): Promise<void> {
  if (job.topic === "issue.classify") {
    await processClassification(client, job);
    return;
  }
  if (job.topic === "issue.recommend") {
    await processRecommendation(client, job);
    return;
  }
  throw new Error(`Unsupported outbox topic: ${job.topic}`);
}

export async function claimNextOutboxJob(
  pool: DatabasePool,
  workerId: string,
): Promise<OutboxJob | null> {
  const claimed = await pool.query<OutboxJob>(
    `SELECT *
     FROM operating_layer.claim_outbox_job($1)`,
    [workerId],
  );
  return claimed.rows[0] ?? null;
}

async function recordJobFailure(
  pool: DatabasePool,
  job: OutboxJob,
  error: unknown,
): Promise<"failed" | "dead_letter"> {
  const safeMessage =
    error instanceof Error
      ? error.message.slice(0, 500)
      : "Unknown job failure";
  const status = job.attempts >= job.max_attempts ? "dead_letter" : "failed";
  await withOrganizationScope(
    pool,
    {
      userId: job.requested_by_user_id,
      organizationIds: [job.organization_id],
    },
    async (client) => {
      await client.query(
        `UPDATE outbox_events
         SET
           status = $2,
           locked_at = NULL,
           locked_by = NULL,
           last_error_code = 'handler_failed',
           safe_error_message = $3,
           available_at = now() + (
             LEAST(60, POWER(2, GREATEST(attempts - 1, 0))) *
               interval '1 second'
           )
         WHERE id = $1
           AND organization_id = $4`,
        [job.id, status, safeMessage, job.organization_id],
      );
    },
  );
  return status;
}

export async function processNextOutboxJob(
  pool: DatabasePool,
  workerId: string,
): Promise<"idle" | "published" | "failed" | "dead_letter"> {
  const job = await claimNextOutboxJob(pool, workerId);
  if (!job) {
    return "idle";
  }

  try {
    await withOrganizationScope(
      pool,
      {
        userId: job.requested_by_user_id,
        organizationIds: [job.organization_id],
      },
      async (client) => {
        await dispatchJob(client, job);
      },
    );
    return "published";
  } catch (error) {
    return recordJobFailure(pool, job, error);
  }
}

export async function drainOutbox(
  pool: DatabasePool,
  workerId: string,
  maximumJobs = 100,
): Promise<{
  published: number;
  failed: number;
  deadLetter: number;
}> {
  const totals = { published: 0, failed: 0, deadLetter: 0 };
  for (let index = 0; index < maximumJobs; index += 1) {
    const result = await processNextOutboxJob(pool, workerId);
    if (result === "idle") {
      break;
    }
    if (result === "published") {
      totals.published += 1;
    } else if (result === "failed") {
      totals.failed += 1;
    } else {
      totals.deadLetter += 1;
    }
  }
  return totals;
}

export function serializeJobForLog(job: OutboxJob): string {
  return canonicalJson({
    id: job.id,
    organizationId: job.organization_id,
    topic: job.topic,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    traceId: job.trace_id,
  });
}
