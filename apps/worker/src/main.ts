import { randomUUID } from "node:crypto";
import {
  assertWorkerDatabaseIdentity,
  createDatabasePool,
} from "@operating-layer/db";
import {
  assertGmailCredentialStartup,
  DisabledOAuthTokenRevoker,
  GoogleOAuthTokenRevoker,
  IDEMPOTENCY_REAPER_INTERVAL_MS,
  processNextOutboxJob,
  reapExpiredIdempotencyKeys,
} from "@operating-layer/issue-intake";
import {
  DisabledGmailDraftExecutionProvider,
  GmailDraftExecutionProvider,
  GoogleGmailDraftCreateTransport,
  resolveExecutionProvider,
} from "@operating-layer/executors";
import { RsaEnvelopeCredentialDecryptor } from "@operating-layer/connectors";

const databaseUrl = process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = createDatabasePool(databaseUrl);
try {
  await assertWorkerDatabaseIdentity(pool);
} catch (error) {
  await pool.end();
  throw error;
}
const privateKey = process.env.CONNECTOR_CREDENTIAL_PRIVATE_KEY_DER_B64;
if (!privateKey) {
  await pool.end();
  throw new Error("CONNECTOR_CREDENTIAL_PRIVATE_KEY_DER_B64 is required");
}
const networkEnabled = process.env.GMAIL_DRAFT_NETWORK_ENABLED === "true";
const credentialRuntime = {
  decryptor: new RsaEnvelopeCredentialDecryptor(privateKey),
  revoker: networkEnabled
    ? new GoogleOAuthTokenRevoker()
    : new DisabledOAuthTokenRevoker(),
};
await assertGmailCredentialStartup(pool, credentialRuntime);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const executionProvider = resolveExecutionProvider(
  process.env.EXECUTION_PROVIDER ?? "deterministic_internal",
);
const gmailDraftProvider = networkEnabled
  ? new GmailDraftExecutionProvider(new GoogleGmailDraftCreateTransport())
  : new DisabledGmailDraftExecutionProvider();
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
let stopping = false;
let nextReaperAt = 0;

async function loop(): Promise<void> {
  while (!stopping) {
    if (Date.now() >= nextReaperAt) {
      const traceId = `idempotency-reaper-${randomUUID()}`;
      try {
        const reaper = await reapExpiredIdempotencyKeys(pool, traceId);
        console.info(
          JSON.stringify({
            event: "idempotency.reaper.completed",
            traceId,
            ...reaper,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "idempotency.reaper.failed",
            traceId,
            message:
              error instanceof Error ? error.message : "Unknown reaper error",
          }),
        );
      } finally {
        nextReaperAt = Date.now() + IDEMPOTENCY_REAPER_INTERVAL_MS;
      }
    }
    const result = await processNextOutboxJob(
      pool,
      workerId,
      executionProvider,
      gmailDraftProvider,
      credentialRuntime,
    );
    if (result === "idle") {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  await loop();
} finally {
  await pool.end();
}
