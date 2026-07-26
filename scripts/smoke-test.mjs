import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { generateKeyPairSync } from "node:crypto";

const repoPath = process.cwd();
const composeArgs = [
  "compose",
  "-f",
  "compose.test.yaml",
  "-p",
  "operating-layer-smoke",
];
const databaseUrl =
  "postgresql://operating_layer_runtime:local-runtime-only@localhost:55432/operating_layer_test";
const workerDatabaseUrl =
  "postgresql://operating_layer_worker_runtime:local-worker-only@localhost:55432/operating_layer_test";
const connectorKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "der", type: "spki" },
  privateKeyEncoding: { format: "der", type: "pkcs8" },
});
const children = [];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function startNode(script, args, cwd, environment) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });
  child.errorOutput = () => errorOutput;
  children.push(child);
  return child;
}

async function waitFor(url, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`${response.url} returned ${response.status}`);
  }
  return response.json();
}

async function waitForPostgresStable() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = spawnSync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "operating_layer",
        "-d",
        "operating_layer_test",
        "-tAc",
        "SELECT count(*) FROM operating_layer.source_systems",
      ],
      { cwd: repoPath, encoding: "utf8" },
    );
    if (first.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const second = spawnSync(
        "docker",
        [
          ...composeArgs,
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "operating_layer",
          "-d",
          "operating_layer_test",
          "-tAc",
          "SELECT count(*) FROM operating_layer.csv_batches",
        ],
        { cwd: repoPath, encoding: "utf8" },
      );
      if (second.status === 0) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("PostgreSQL did not become stably available");
}

try {
  run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
  run("docker", [...composeArgs, "up", "--detach", "--wait", "postgres"]);
  await waitForPostgresStable();

  const api = startNode(
    path.join(repoPath, "apps/api/dist/main.js"),
    [],
    repoPath,
    {
      AUTH_MODE: "local",
      API_PORT: "3301",
      DATABASE_URL: databaseUrl,
      CONNECTOR_CREDENTIAL_PUBLIC_KEY_DER_B64:
        connectorKeyPair.publicKey.toString("base64"),
    },
  );
  const web = startNode(
    path.join(repoPath, "apps/web/node_modules/next/dist/bin/next"),
    ["start", "-p", "3300"],
    path.join(repoPath, "apps/web"),
    {
      API_BASE_URL: "http://localhost:3301",
      DEFAULT_ORGANIZATION_ID: "10000000-0000-4000-8000-000000000001",
      DEV_USER_EMAIL: "executive@local.operating-layer",
    },
  );

  const healthResponse = await waitFor("http://localhost:3301/health");
  startNode(path.join(repoPath, "apps/worker/dist/main.js"), [], repoPath, {
    WORKER_DATABASE_URL: workerDatabaseUrl,
    CONNECTOR_CREDENTIAL_PRIVATE_KEY_DER_B64:
      connectorKeyPair.privateKey.toString("base64"),
    WORKER_ID: "process-smoke-worker",
    WORKER_POLL_INTERVAL_MS: "100",
  });
  await waitFor("http://localhost:3300");
  const health = await readJson(healthResponse);
  const idempotencyKey = `process-smoke-${crypto.randomUUID()}`;
  const issue = await readJson(
    await fetch("http://localhost:3301/v1/issues", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-dev-user-email": "operator@local.operating-layer",
        "x-trace-id": idempotencyKey,
      },
      body: JSON.stringify({
        organizationId: "10000000-0000-4000-8000-000000000001",
        title: "Process smoke test operational follow-up",
        description:
          "A $125,000 receivable needs internal approval before follow-up.",
        financialExposure: 125000,
        financialExposureCurrency: "USD",
        retentionClassification: "financial_support",
      }),
    }),
  );

  let detail;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    detail = await readJson(
      await fetch(
        `http://localhost:3301/v1/tasks/${issue.taskId}?organizationId=10000000-0000-4000-8000-000000000001`,
        { headers: { "x-dev-user-email": "operator@local.operating-layer" } },
      ),
    );
    if (
      ["completed", "awaiting_approval"].includes(
        detail.workflows[0]?.current_state,
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (detail?.workflows[0]?.current_state !== "awaiting_approval") {
    throw new Error("worker did not route the smoke-test workflow to approval");
  }

  const pendingTaskResponse = await fetch(
    `http://localhost:3300/tasks/${issue.taskId}?organizationId=10000000-0000-4000-8000-000000000001`,
  );
  const pendingTaskHtml = await pendingTaskResponse.text();
  if (
    !pendingTaskResponse.ok ||
    !pendingTaskHtml.includes("Approve internally")
  ) {
    throw new Error("task detail did not render the approval control");
  }

  const approvalId = detail.approvals[0]?.id;
  if (!approvalId) {
    throw new Error("approval-pending workflow has no approval record");
  }
  const resolutionReason = "Approved by the process smoke test.";
  const resolution = await readJson(
    await fetch(`http://localhost:3301/v1/approvals/${approvalId}/resolution`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `process-smoke-approval-${crypto.randomUUID()}`,
        "x-dev-user-email": "approver@local.operating-layer",
        "x-trace-id": idempotencyKey,
      },
      body: JSON.stringify({
        organizationId: "10000000-0000-4000-8000-000000000001",
        decision: "approved",
        reason: resolutionReason,
      }),
    }),
  );
  if (resolution.workflowState !== "approved") {
    throw new Error("approval resolution did not stop at executable approval");
  }

  const execution = await readJson(
    await fetch(`http://localhost:3301/v1/approvals/${approvalId}/executions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `process-smoke-execution-${crypto.randomUUID()}`,
        "x-dev-user-email": "approver@local.operating-layer",
        "x-trace-id": idempotencyKey,
      },
      body: JSON.stringify({
        organizationId: "10000000-0000-4000-8000-000000000001",
      }),
    }),
  );
  if (execution.status !== "queued") {
    throw new Error("approved internal execution was not queued");
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    detail = await readJson(
      await fetch(
        `http://localhost:3301/v1/tasks/${issue.taskId}?organizationId=10000000-0000-4000-8000-000000000001`,
        { headers: { "x-dev-user-email": "operator@local.operating-layer" } },
      ),
    );
    if (detail.workflows[0]?.current_state === "completed") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (detail?.workflows[0]?.current_state !== "completed") {
    throw new Error("internal executor did not reach completed");
  }

  const csvTraceId = `process-smoke-csv-${crypto.randomUUID()}`;
  const csvBatch = await readJson(
    await fetch("http://localhost:3300/api/csv-batches", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": csvTraceId,
        "x-trace-id": csvTraceId,
      },
      body: JSON.stringify({
        organizationId: "10000000-0000-4000-8000-000000000001",
        fileName: "process-smoke.csv",
        content: [
          "title,description,task_type",
          "Smoke CSV issue,Create an internal operational follow-up,operations",
          "Rejected smoke row,,operations",
        ].join("\n"),
        sourceTimestamp: "2026-07-25T16:00:00.000Z",
        schemaVersion: "csv-issue.v1",
        retentionClassification: "operational",
      }),
    }),
  );
  let csvResult;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    csvResult = await readJson(
      await fetch(
        `http://localhost:3301/v1/csv-batches/${csvBatch.batchId}?organizationId=10000000-0000-4000-8000-000000000001`,
        { headers: { "x-dev-user-email": "executive@local.operating-layer" } },
      ),
    );
    if (csvResult.counts?.pending === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (
    csvResult?.counts?.accepted !== 1 ||
    csvResult?.counts?.rejected !== 1 ||
    csvResult?.counts?.pending !== 0
  ) {
    throw new Error("controlled CSV batch did not reach partial completion");
  }

  const [
    homeResponse,
    intakeResponse,
    csvIntakeResponse,
    csvResultResponse,
    taskResponse,
  ] = await Promise.all([
    fetch("http://localhost:3300"),
    fetch("http://localhost:3300/issues/new"),
    fetch("http://localhost:3300/csv-batches/new"),
    fetch(
      `http://localhost:3300/csv-batches/${csvBatch.batchId}?organizationId=10000000-0000-4000-8000-000000000001`,
    ),
    fetch(
      `http://localhost:3300/tasks/${issue.taskId}?organizationId=10000000-0000-4000-8000-000000000001`,
    ),
  ]);
  if (
    !homeResponse.ok ||
    !intakeResponse.ok ||
    !csvIntakeResponse.ok ||
    !csvResultResponse.ok ||
    !taskResponse.ok
  ) {
    throw new Error(
      `web routes failed: home=${homeResponse.status}, intake=${intakeResponse.status}, csvIntake=${csvIntakeResponse.status}, csvResult=${csvResultResponse.status}, task=${taskResponse.status}`,
    );
  }
  const [homeHtml, csvIntakeHtml, csvResultHtml, taskHtml] = await Promise.all([
    homeResponse.text(),
    csvIntakeResponse.text(),
    csvResultResponse.text(),
    taskResponse.text(),
  ]);
  if (
    !homeHtml.includes("Recent approval outcomes") ||
    !homeHtml.includes("Recent execution outcomes") ||
    !csvIntakeHtml.includes("Upload operational issues") ||
    !csvResultHtml.includes("process-smoke.csv") ||
    !csvResultHtml.includes("Per-row outcome") ||
    !csvResultHtml.includes("accepted") ||
    !csvResultHtml.includes("rejected") ||
    !csvResultHtml.includes("Open created task") ||
    !taskHtml.includes(resolutionReason) ||
    !taskHtml.includes("Approval resolution") ||
    !taskHtml.includes("Execution result") ||
    !taskHtml.includes("deterministic-internal-v1")
  ) {
    throw new Error(
      "approval or internal execution was not visible in the web UI",
    );
  }

  console.log(
    JSON.stringify(
      {
        apiHealth: health.status,
        taskId: issue.taskId,
        workflowState: detail.workflows[0]?.current_state,
        approvalDecision: resolution.decision,
        executionProvider: detail.executionResults[0]?.executor_provider,
        executionOutcome: detail.executionResults[0]?.outcome,
        recommendationCount: detail.recommendations.length,
        auditEventCount: detail.auditHistory.length,
        csvBatchId: csvBatch.batchId,
        csvAcceptedRows: csvResult.counts.accepted,
        csvRejectedRows: csvResult.counts.rejected,
        executivePageStatus: homeResponse.status,
        intakePageStatus: intakeResponse.status,
        csvIntakePageStatus: csvIntakeResponse.status,
        csvResultPageStatus: csvResultResponse.status,
        taskPageStatus: taskResponse.status,
      },
      null,
      2,
    ),
  );

  if (api.exitCode !== null) {
    throw new Error(`API exited early: ${api.errorOutput()}`);
  }
  if (web.exitCode !== null) {
    throw new Error(`web exited early: ${web.errorOutput()}`);
  }
} catch (error) {
  for (const child of children) {
    if (child.exitCode !== null || child.errorOutput()) {
      console.error(
        `child ${child.spawnfile} exited=${child.exitCode}: ${child.errorOutput()}`,
      );
    }
  }
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  spawnSync(
    "docker",
    [...composeArgs, "down", "--volumes", "--remove-orphans"],
    {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
}
