import { randomUUID } from "node:crypto";
import {
  assertSafeRuntimeDatabaseIdentity,
  createDatabasePool,
} from "@operating-layer/db";
import {
  IDEMPOTENCY_REAPER_INTERVAL_MS,
  processNextOutboxJob,
  reapExpiredIdempotencyKeys,
} from "@operating-layer/issue-intake";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = createDatabasePool(databaseUrl);
try {
  await assertSafeRuntimeDatabaseIdentity(pool);
} catch (error) {
  await pool.end();
  throw error;
}
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
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
    const result = await processNextOutboxJob(pool, workerId);
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
