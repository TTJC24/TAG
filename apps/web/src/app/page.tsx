import Link from "next/link";
import { defaultOrganizationId, operatingLayerApi } from "../lib/api";

export const dynamic = "force-dynamic";

interface Organization {
  id: string;
  name: string;
  code: string;
}

interface QueueTask {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueDate: string | null;
  financialExposure: string | null;
  financialExposureCurrency: string | null;
  ownerName: string | null;
  workflowState: string | null;
  approvalStatus: string | null;
  recommendationSummary: string | null;
}

interface QueueResponse {
  organization: Organization;
  generatedAt: string;
  counts: {
    open: number;
    overdue: number;
    blocked: number;
    approvalPending: number;
    failedJobs: number;
  };
  tasks: QueueTask[];
  recentResolutions: Array<{
    id: string;
    taskId: string;
    taskTitle: string;
    decision: "approved" | "rejected";
    reason: string;
    resultingWorkflowState: string;
    policyVersionId: string;
    resolverName: string;
    resolvedAt: string;
  }>;
  jobFailures: Array<{
    id: string;
    topic: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    safeErrorMessage: string | null;
  }>;
}

interface OrganizationsResponse {
  organizations: Organization[];
  user: { name: string; email: string };
}

function exposure(task: QueueTask): string {
  if (!task.financialExposure || !task.financialExposureCurrency) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: task.financialExposureCurrency,
    maximumFractionDigits: 0,
  }).format(Number(task.financialExposure));
}

export default async function ExecutiveQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const params = await searchParams;
  const organizations =
    await operatingLayerApi<OrganizationsResponse>("/v1/organizations");
  const requestedOrganizationId =
    params.organizationId ?? defaultOrganizationId;
  const selectedOrganizationId = organizations.organizations.some(
    (organization) => organization.id === requestedOrganizationId,
  )
    ? requestedOrganizationId
    : organizations.organizations[0]?.id;

  if (!selectedOrganizationId) {
    return (
      <section className="emptyState">
        <p className="eyebrow">Access required</p>
        <h1>No authorized organizations</h1>
        <p>Your identity is active but has no organization membership.</p>
      </section>
    );
  }

  const queue = await operatingLayerApi<QueueResponse>(
    `/v1/executive-queue?organizationId=${encodeURIComponent(
      selectedOrganizationId,
    )}`,
  );

  return (
    <div className="pageStack">
      <section className="pageHeading">
        <div>
          <p className="eyebrow">Executive operations queue</p>
          <h1>What needs attention now</h1>
          <p className="lede">
            Prioritized work with source-backed recommendations, approval state,
            and a complete operational trail.
          </p>
        </div>
        <div className="identityCard">
          <span>Viewing as</span>
          <strong>{organizations.user.name}</strong>
          <small>{organizations.user.email}</small>
        </div>
      </section>

      <section className="entityTabs" aria-label="Organization selector">
        {organizations.organizations.map((organization) => (
          <Link
            className={
              organization.id === selectedOrganizationId ? "active" : ""
            }
            href={`/?organizationId=${organization.id}`}
            key={organization.id}
          >
            <span>{organization.code}</span>
            {organization.name}
          </Link>
        ))}
      </section>

      <section className="metricGrid" aria-label="Queue summary">
        <article>
          <span>Open work</span>
          <strong>{queue.counts.open}</strong>
          <small>Active items</small>
        </article>
        <article className={queue.counts.overdue > 0 ? "warn" : ""}>
          <span>Overdue</span>
          <strong>{queue.counts.overdue}</strong>
          <small>Past due date</small>
        </article>
        <article className={queue.counts.blocked > 0 ? "danger" : ""}>
          <span>Blocked</span>
          <strong>{queue.counts.blocked}</strong>
          <small>Needs intervention</small>
        </article>
        <article className={queue.counts.approvalPending > 0 ? "accent" : ""}>
          <span>Approvals</span>
          <strong>{queue.counts.approvalPending}</strong>
          <small>Human decision pending</small>
        </article>
        <article className={queue.counts.failedJobs > 0 ? "danger" : ""}>
          <span>Failed jobs</span>
          <strong>{queue.counts.failedJobs}</strong>
          <small>Retry or dead-letter</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">{queue.organization.code}</p>
            <h2>Prioritized work</h2>
          </div>
          <Link
            className="button"
            href={`/issues/new?organizationId=${selectedOrganizationId}`}
          >
            Add operational issue
          </Link>
        </div>

        {queue.tasks.length === 0 ? (
          <div className="emptyTable">
            <strong>No open issues</strong>
            <p>Create a manual issue to start the controlled workflow.</p>
          </div>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Issue</th>
                  <th>Owner</th>
                  <th>Exposure</th>
                  <th>Workflow</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {queue.tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <span
                        className={`priority ${task.priority.toLowerCase()}`}
                      >
                        {task.priority}
                      </span>
                    </td>
                    <td className="issueCell">
                      <Link
                        href={`/tasks/${task.id}?organizationId=${selectedOrganizationId}`}
                      >
                        {task.title}
                      </Link>
                      <small>
                        {task.recommendationSummary ?? task.taskType}
                      </small>
                    </td>
                    <td>{task.ownerName ?? "Unassigned"}</td>
                    <td>{exposure(task)}</td>
                    <td>
                      <span
                        className={`status ${
                          task.approvalStatus === "pending" ? "pending" : ""
                        }`}
                      >
                        {task.approvalStatus === "pending"
                          ? "Approval pending"
                          : (task.workflowState ?? task.status)}
                      </span>
                    </td>
                    <td>{task.dueDate ?? "No date"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {queue.recentResolutions.length > 0 ? (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Closed approval loop</p>
              <h2>Recent approval outcomes</h2>
            </div>
          </div>
          <ul className="resolutionList">
            {queue.recentResolutions.map((resolution) => (
              <li key={resolution.id}>
                <div>
                  <Link
                    href={`/tasks/${resolution.taskId}?organizationId=${selectedOrganizationId}`}
                  >
                    {resolution.taskTitle}
                  </Link>
                  <small>{resolution.reason}</small>
                </div>
                <div>
                  <span className={`status ${resolution.decision}`}>
                    {resolution.decision}
                  </span>
                  <small>{resolution.resolverName}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {queue.jobFailures.length > 0 ? (
        <section className="panel failurePanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Operational health</p>
              <h2>Failed background work</h2>
            </div>
          </div>
          <ul className="failureList">
            {queue.jobFailures.map((failure) => (
              <li key={failure.id}>
                <strong>{failure.topic}</strong>
                <span>
                  {failure.status} · attempt {failure.attempts} of{" "}
                  {failure.maxAttempts}
                </span>
                <small>{failure.safeErrorMessage}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
