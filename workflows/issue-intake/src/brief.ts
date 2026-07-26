import type { DatabasePool } from "@operating-layer/db";
import type { ApplicationPrincipal } from "./identity.js";
import { getExecutiveQueue } from "./service.js";

/**
 * Morning brief generator: the machine writes the cockpit page.
 *
 * Renders live operating-layer state (executive queue, approvals pending,
 * failures, recent outcomes) as an Obsidian-ready markdown note, one section
 * per organization the acting user can read. Intended to land in the WORKOS
 * vault as brief.md, replacing hand-maintained bookkeeping while the vault
 * remains the human cockpit. Strictly read-only over system state.
 */

interface QueueTask {
  id: string;
  title: string;
  taskType: string | null;
  status: string;
  priority: string | null;
  dueDate: string | Date | null;
  ownerName: string | null;
  workflowState: string | null;
  recommendationSummary: string | null;
  riskLevel: number | null;
}

interface QueueSnapshot {
  organization: { id: string; name: string; code: string };
  generatedAt: string;
  counts: Record<string, number>;
  open: QueueTask[];
  overdue: QueueTask[];
  blocked: QueueTask[];
  approvalPending: QueueTask[];
  awaitingExternalAuthorization: QueueTask[];
  inExecution: QueueTask[];
  executionFailed: QueueTask[];
  recentResolutions: Array<{
    decision: string;
    taskTitle: string;
    resolverName: string;
    resolvedAt: string | Date;
  }>;
  recentExecutions: Array<{
    taskTitle: string;
    outcome: string;
    actionType: string;
  }>;
  jobFailures: Array<{
    topic: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    safeErrorMessage: string | null;
  }>;
}

function formatDue(value: string | Date | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : ` (due ${date.toISOString().slice(0, 10)})`;
}

function taskLine(task: QueueTask): string {
  const priority = task.priority ? `**${task.priority}** ` : "";
  const owner = task.ownerName ? ` — ${task.ownerName}` : "";
  return `- ${priority}${task.title}${formatDue(task.dueDate)}${owner}`;
}

function approvalLine(task: QueueTask): string {
  const risk =
    typeof task.riskLevel === "number" ? ` (risk ${task.riskLevel}/5)` : "";
  const recommendation = task.recommendationSummary
    ? `\n  - Recommended: ${task.recommendationSummary}${risk}`
    : "";
  return `${taskLine(task)}${recommendation}`;
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [`### ${title}`, ...lines, ""];
}

function renderOrganization(snapshot: QueueSnapshot): string {
  const counts = snapshot.counts;
  const headline = [
    `${counts.open ?? 0} open`,
    `${counts.approvalPending ?? 0} awaiting your approval`,
    `${counts.overdue ?? 0} overdue`,
    `${(counts.blocked ?? 0) + (counts.executionFailed ?? 0) + (counts.failedJobs ?? 0)} stuck`,
  ].join(" · ");

  const stuckLines = [
    ...snapshot.blocked.map(taskLine),
    ...snapshot.executionFailed.map(
      (task) => `${taskLine(task)} — execution failed`,
    ),
    ...snapshot.jobFailures.map(
      (failure) =>
        `- job ${failure.topic} ${failure.status} after ${failure.attempts}/${failure.maxAttempts} attempts${failure.safeErrorMessage ? `: ${failure.safeErrorMessage}` : ""}`,
    ),
  ];

  const landedLines = [
    ...snapshot.recentResolutions
      .slice(0, 5)
      .map(
        (resolution) =>
          `- ${resolution.decision === "approved" ? "✅ approved" : "⛔ rejected"}: ${resolution.taskTitle} — ${resolution.resolverName}`,
      ),
    ...snapshot.recentExecutions
      .slice(0, 5)
      .map(
        (execution) =>
          `- ${execution.outcome === "succeeded" ? "✅ done" : "❌ failed"}: ${execution.taskTitle} (${execution.actionType})`,
      ),
  ];

  return [
    `## ${snapshot.organization.name} (${snapshot.organization.code})`,
    "",
    `> ${headline}`,
    "",
    ...section(
      "Needs your decision",
      snapshot.approvalPending.map(approvalLine),
    ),
    ...section(
      "Awaiting external authorization",
      snapshot.awaitingExternalAuthorization.map(taskLine),
    ),
    ...section("Overdue", snapshot.overdue.map(taskLine)),
    ...section("Stuck", stuckLines),
    ...section("In motion", snapshot.inExecution.map(taskLine)),
    ...section("Recently landed", landedLines),
  ].join("\n");
}

export interface MorningBriefOptions {
  /** Restrict to these organization ids; defaults to all the user can read. */
  organizationIds?: string[];
  generatedAt?: string;
}

export async function generateMorningBrief(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
  options: MorningBriefOptions = {},
): Promise<string> {
  const organizationIds = options.organizationIds ?? principal.organizationIds;
  const snapshots: QueueSnapshot[] = [];
  for (const organizationId of organizationIds) {
    const snapshot = (await getExecutiveQueue(
      pool,
      principal,
      organizationId,
    )) as unknown as QueueSnapshot;
    snapshots.push(snapshot);
  }
  snapshots.sort((a, b) =>
    a.organization.code.localeCompare(b.organization.code),
  );

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const totalApprovals = snapshots.reduce(
    (sum, snapshot) => sum + (snapshot.counts.approvalPending ?? 0),
    0,
  );

  return [
    "---",
    "source: operating-layer",
    `generated: ${generatedAt}`,
    "tags: [workos/brief]",
    "---",
    "",
    "# Morning Brief",
    "",
    totalApprovals > 0
      ? `**${totalApprovals} item${totalApprovals === 1 ? "" : "s"} waiting on your approval.**`
      : "**Nothing is waiting on your approval.**",
    "",
    ...snapshots.map(renderOrganization),
    "",
    "---",
    "_Generated from the operating layer's live state (executive queue,",
    "approvals, failures, recent outcomes). This note is machine-written;",
    "edits will be overwritten by the next generation._",
  ].join("\n");
}
