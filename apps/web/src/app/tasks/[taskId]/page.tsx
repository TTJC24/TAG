import Link from "next/link";
import { operatingLayerApi } from "../../../lib/api";

export const dynamic = "force-dynamic";

interface TaskDetail {
  task: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
  recommendations: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
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
  const detail = await operatingLayerApi<TaskDetail>(
    `/v1/tasks/${encodeURIComponent(
      taskId,
    )}?organizationId=${encodeURIComponent(query.organizationId)}`,
  );
  const task = detail.task;

  return (
    <div className="pageStack">
      <div className="breadcrumb">
        <Link href={`/?organizationId=${query.organizationId}`}>
          Executive queue
        </Link>
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
              <h2>Pending approval</h2>
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
