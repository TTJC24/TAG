import Link from "next/link";
import { ApiError, operatingLayerApi } from "../../../lib/api";
import { ApprovalResolutionForm } from "./approval-resolution-form";
import { ExecutionTriggerForm } from "./execution-trigger-form";
import { MailDraftAuthorizationForm } from "./mail-draft-authorization-form";
import { MailDraftPreviewForm } from "./mail-draft-preview-form";

export const dynamic = "force-dynamic";

interface ChaseProposal {
  customerName: string;
  recipient: string | null;
  blockedReason: string | null;
  subject: string;
  body: string;
  ladderStep: number;
  pastDue: number;
}

interface TaskDetail {
  task: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
  recommendations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  approvalResolutions: Array<Record<string, unknown>>;
  executionCommands: Array<Record<string, unknown>>;
  executionResults: Array<Record<string, unknown>>;
  mailDraftConnector: Record<string, unknown>;
  mailDraftPreviews: Array<Record<string, unknown>>;
  mailDraftAuthorizations: Array<Record<string, unknown>>;
  mailDraftAbandonments: Array<Record<string, unknown>>;
  auditHistory: Array<Record<string, unknown>>;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ taskId: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const { taskId } = await params;
  const query = await searchParams;
  if (!query.organizationId) {
    throw new Error("An explicit organizationId is required");
  }
  const organizationId = query.organizationId;
  const detail = await operatingLayerApi<TaskDetail>(
    `/v1/tasks/${encodeURIComponent(
      taskId,
    )}?organizationId=${encodeURIComponent(organizationId)}`,
  );
  // The chase text recorded when this task was raised, if any. Collections
  // tasks have one; everything else does not, and then the draft form stays
  // exactly as it was — the prefill is additive, never a precondition.
  // A 404 is the ordinary "this is not a collections task" answer. Anything
  // else (403, 500, the API being down) must not masquerade as "no proposal",
  // or a broken route silently hands the approver an empty form to retype.
  const chaseProposal = await operatingLayerApi<ChaseProposal>(
    `/v1/tasks/${encodeURIComponent(
      taskId,
    )}/chase-proposal?organizationId=${encodeURIComponent(organizationId)}`,
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  const task = detail.task;
  const connectorEnabled = detail.mailDraftConnector.enabled === true;
  const latestPreview = detail.mailDraftPreviews.at(-1);
  const latestAuthorization = detail.mailDraftAuthorizations.at(-1);
  const workflowState = display(detail.workflows.at(-1)?.current_state);
  const canExecuteInternally =
    workflowState === "approved" &&
    (detail.executionCommands.length === 0 ||
      detail.mailDraftAbandonments.length > 0);

  return (
    <div className="pageStack">
      <div className="breadcrumb">
        <Link href={`/?organizationId=${organizationId}`}>Executive queue</Link>
        <span>/</span>
        <span>Task detail</span>
      </div>
      <section className="taskHero">
        <div>
          <div className="taskBadges">
            <span
              className={`priority ${display(task.priority).toLowerCase()}`}
            >
              {display(task.priority)}
            </span>
            <span className="status">{display(task.status)}</span>
            <span className="entityBadge">
              {display(task.organization_code)}
            </span>
          </div>
          <h1>{display(task.title)}</h1>
          <p>{display(task.description)}</p>
        </div>
        <dl className="taskFacts">
          <div>
            <dt>Owner</dt>
            <dd>{display(task.owner_name)}</dd>
          </div>
          <div>
            <dt>Task type</dt>
            <dd>{display(task.task_type)}</dd>
          </div>
          <div>
            <dt>Due date</dt>
            <dd>{display(task.due_date)}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{display(task.confidence)}</dd>
          </div>
        </dl>
      </section>

      <div className="detailGrid">
        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Recommended action</p>
              <h2>Agent recommendation</h2>
            </div>
          </div>
          {detail.recommendations.length === 0 ? (
            <p className="muted">
              Classification or recommendation is still processing.
            </p>
          ) : (
            detail.recommendations.map((recommendation) => (
              <article
                className="recommendation"
                key={display(recommendation.id)}
              >
                <strong>{display(recommendation.summary)}</strong>
                <p>{display(recommendation.reasoning_summary)}</p>
                <dl>
                  <div>
                    <dt>Risk</dt>
                    <dd>Level {display(recommendation.risk_level)}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>{display(recommendation.confidence)}</dd>
                  </div>
                  <div>
                    <dt>Approval</dt>
                    <dd>
                      {recommendation.requires_approval
                        ? "Required"
                        : "Not required"}
                    </dd>
                  </div>
                </dl>
              </article>
            ))
          )}
        </section>

        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Source provenance</p>
              <h2>Supporting records</h2>
            </div>
          </div>
          <ul className="sourceList">
            {detail.sources.map((source) => (
              <li key={display(source.versionId)}>
                <strong>{display(source.recordType)}</strong>
                <span>{display(source.externalId)}</span>
                <small>
                  SHA-256 {display(source.checksum).slice(0, 14)}… · ingested{" "}
                  {display(source.ingestedAt)}
                </small>
                <small>
                  {display(source.schemaVersion)} ·{" "}
                  {display(source.retentionClassification)}
                </small>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Durable workflow</p>
            <h2>State history</h2>
          </div>
        </div>
        <ol className="timeline">
          {detail.transitions.map((transition) => (
            <li key={display(transition.id)}>
              <span className="timelineDot" />
              <div>
                <strong>
                  {display(transition.from_state)} →{" "}
                  {display(transition.to_state)}
                </strong>
                <p>
                  Version {display(transition.workflow_version)} ·{" "}
                  {display(transition.actor_type)}
                </p>
                <small>{display(transition.occurred_at)}</small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {detail.approvals.length > 0 ? (
        <section className="panel approvalPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Human control</p>
              <h2>Approval control</h2>
            </div>
          </div>
          {detail.approvals.map((approval) => (
            <article key={display(approval.id)}>
              <strong>{display(approval.action_type)}</strong>
              <p>
                Risk level {display(approval.risk_level)} · policy{" "}
                {display(approval.policy_version)}
              </p>
              <span className="status pending">{display(approval.status)}</span>
              {approval.status === "pending" ? (
                <ApprovalResolutionForm
                  approvalId={display(approval.id)}
                  organizationId={organizationId}
                />
              ) : null}
              {approval.status === "approved" && canExecuteInternally ? (
                <ExecutionTriggerForm
                  approvalId={display(approval.id)}
                  organizationId={organizationId}
                />
              ) : null}
              {approval.status === "approved" &&
              canExecuteInternally &&
              approval.action_type === "draft_external_follow_up" &&
              connectorEnabled &&
              !latestPreview ? (
                <MailDraftPreviewForm
                  approvalId={display(approval.id)}
                  organizationId={organizationId}
                  proposal={chaseProposal}
                />
              ) : null}
              {approval.action_type === "draft_external_follow_up" &&
              !connectorEnabled ? (
                <p className="muted">
                  Outlook draft materialization is disabled. Internal execution
                  remains available.
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {detail.mailDraftPreviews.length > 0 ? (
        <section className="panel executionPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Exact external-action preview</p>
              <h2>Outlook draft preview</h2>
            </div>
          </div>
          {detail.mailDraftPreviews.map((preview) => (
            <article key={display(preview.id)}>
              <dl>
                <div>
                  <dt>To</dt>
                  <dd>{display(preview.recipient)}</dd>
                </div>
                <div>
                  <dt>Subject</dt>
                  <dd>{display(preview.subject)}</dd>
                </div>
                <div>
                  <dt>Payload hash</dt>
                  <dd>{display(preview.rendered_payload_hash)}</dd>
                </div>
                <div>
                  <dt>Requested by</dt>
                  <dd>{display(preview.requester_name)}</dd>
                </div>
              </dl>
              <pre>{display(preview.body)}</pre>
              {!latestAuthorization &&
              workflowState === "awaiting_external_authorization" ? (
                <MailDraftAuthorizationForm
                  previewId={display(preview.id)}
                  organizationId={organizationId}
                />
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {detail.mailDraftAuthorizations.length > 0 ? (
        <section className="panel approvalPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Second human gate</p>
              <h2>Outlook draft authorization</h2>
            </div>
          </div>
          {detail.mailDraftAuthorizations.map((authorization) => (
            <article key={display(authorization.id)}>
              <strong>{display(authorization.authorizer_name)}</strong>
              <p>{display(authorization.reason)}</p>
              <small>
                {display(authorization.authorized_at)} · config{" "}
                {display(authorization.connector_config_version_id)}
              </small>
            </article>
          ))}
        </section>
      ) : null}

      {detail.mailDraftAbandonments.length > 0 ? (
        <section className="panel failurePanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Kill switch</p>
              <h2>External materialization halted</h2>
            </div>
          </div>
          {detail.mailDraftAbandonments.map((abandonment) => (
            <article key={display(abandonment.id)}>
              <strong>{display(abandonment.reason_code)}</strong>
              <p>
                No Mail call was made. The workflow returned to approved for
                internal execution.
              </p>
            </article>
          ))}
        </section>
      ) : null}

      {detail.approvalResolutions.length > 0 ? (
        <section className="panel approvalPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Recorded decision</p>
              <h2>Approval resolution</h2>
            </div>
          </div>
          {detail.approvalResolutions.map((resolution) => (
            <article key={display(resolution.id)}>
              <strong>{display(resolution.decision)}</strong>
              <p>{display(resolution.reason)}</p>
              <dl>
                <div>
                  <dt>Resolver</dt>
                  <dd>{display(resolution.resolver_name)}</dd>
                </div>
                <div>
                  <dt>Policy version</dt>
                  <dd>{display(resolution.policy_version_id)}</dd>
                </div>
                <div>
                  <dt>Resulting state</dt>
                  <dd>{display(resolution.resulting_workflow_state)}</dd>
                </div>
                <div>
                  <dt>Resolved</dt>
                  <dd>{display(resolution.resolved_at)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      ) : null}

      {detail.executionCommands.length > 0 ? (
        <section className="panel executionPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Internal execution</p>
              <h2>Execution command</h2>
            </div>
          </div>
          {detail.executionCommands.map((command) => (
            <article key={display(command.id)}>
              <strong>{display(command.action_type)}</strong>
              <p>{display(command.action_summary)}</p>
              <dl>
                <div>
                  <dt>Provider</dt>
                  <dd>{display(command.provider_name)}</dd>
                </div>
                <div>
                  <dt>Requested by</dt>
                  <dd>{display(command.requester_name)}</dd>
                </div>
                <div>
                  <dt>Trace</dt>
                  <dd>{display(command.trace_id)}</dd>
                </div>
                <div>
                  <dt>Queued</dt>
                  <dd>{display(command.created_at)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      ) : null}

      {detail.executionResults.length > 0 ? (
        <section className="panel executionPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Recorded outcome</p>
              <h2>Execution result</h2>
            </div>
          </div>
          {detail.executionResults.map((result) => (
            <article key={display(result.id)}>
              <strong>{display(result.outcome)}</strong>
              <p>{display(result.outcome_summary)}</p>
              <dl>
                <div>
                  <dt>Executor</dt>
                  <dd>{display(result.executor_id)}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{display(result.action_type)}</dd>
                </div>
                <div>
                  <dt>Terminal state</dt>
                  <dd>{display(result.resulting_workflow_state)}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>{display(result.completed_at)}</dd>
                </div>
              </dl>
              {result.executor_provider === "mail_draft" &&
              result.outcome === "succeeded" ? (
                <p>
                  Draft ID:{" "}
                  {display(
                    (
                      result.output_payload as
                        Record<string, unknown> | undefined
                    )?.draftId,
                  )}
                  {" · "}
                  <a
                    href={display(
                      (
                        result.output_payload as
                          Record<string, unknown> | undefined
                      )?.draftLink,
                    )}
                  >
                    Open draft
                  </a>
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Immutable evidence</p>
            <h2>Audit history</h2>
          </div>
        </div>
        <div className="auditList">
          {detail.auditHistory.map((event) => (
            <article key={display(event.id)}>
              <div>
                <strong>{display(event.eventType)}</strong>
                <span>
                  Sequence {display(event.streamSequence)} ·{" "}
                  {display(event.actorType)}
                </span>
              </div>
              <code>{display(event.eventHash).slice(0, 18)}…</code>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
