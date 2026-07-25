import { createDatabasePool } from "@operating-layer/db";
import { processNextOutboxJob } from "@operating-layer/issue-intake";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = createDatabasePool(databaseUrl);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
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
