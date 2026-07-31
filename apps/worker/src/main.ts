import { randomUUID } from "node:crypto";
import {
  assertWorkerDatabaseIdentity,
  createDatabasePool,
} from "@operating-layer/db";
import {
  assertMailCredentialStartup,
  DisabledOAuthTokenRevoker,
  FeedRunLog,
  GraphOAuthTokenRevoker,
  IDEMPOTENCY_REAPER_INTERVAL_MS,
  processNextOutboxJob,
  reapExpiredIdempotencyKeys,
  resolveFeedSchedules,
  runCollectionsFeed,
  runSalesFeed,
} from "@operating-layer/issue-intake";
import {
  DisabledMailDraftExecutionProvider,
  MailDraftExecutionProvider,
  GraphMailDraftCreateTransport,
  resolveExecutionProvider,
} from "@operating-layer/executors";
import { RsaEnvelopeCredentialDecryptor } from "@operating-layer/connectors";

// Scheduled feed refreshes. Empty unless *_SCHEDULE_UTC is set explicitly, so
// this ships inert and an unconfigured deploy behaves exactly as before.
const feedSchedules = resolveFeedSchedules();

// Stated FIRST, before the database and credential checks, and unconditionally.
//
// The worker is the only component that can authenticate against Acumatica with
// no human present, so its effective environment is the authoritative answer to
// "is unattended operation disabled?". `docker compose exec worker …` reports
// the container's environment — what a RESTART would produce. This line reports
// what the process actually running right now decided, and the two differ
// whenever the environment changed without a restart.
//
// Before the startup assertions on purpose: a worker crash-looping on a
// database or credential problem is not scheduling anything, but an operator
// still needs to see that stated rather than inferred from a silent log.
// Absence of a log line is not evidence — a rotated log, a failed startup and a
// correctly-disabled feed all look identical.
console.info(
  JSON.stringify({
    event: "acumatica.unattended.status",
    unattendedEnvRaw: process.env.ACUMATICA_UNATTENDED_ENABLED ?? null,
    // The only accepted value is the exact string "true".
    unattendedPermitted: process.env.ACUMATICA_UNATTENDED_ENABLED === "true",
    collectionsScheduleUtc: process.env.COLLECTIONS_SCHEDULE_UTC ?? null,
    collectionsScheduled: feedSchedules.some((f) => f.name === "collections"),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  }),
);

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
const networkEnabled = process.env.MAIL_DRAFT_NETWORK_ENABLED === "true";
const credentialRuntime = {
  decryptor: new RsaEnvelopeCredentialDecryptor(privateKey),
  revoker: networkEnabled
    ? new GraphOAuthTokenRevoker()
    : new DisabledOAuthTokenRevoker(),
};
await assertMailCredentialStartup(pool, credentialRuntime);
const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
const executionProvider = resolveExecutionProvider(
  process.env.EXECUTION_PROVIDER ?? "deterministic_internal",
);
const mailDraftProvider = networkEnabled
  ? new MailDraftExecutionProvider(new GraphMailDraftCreateTransport())
  : new DisabledMailDraftExecutionProvider();
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
const feedRunLog = new FeedRunLog();
// Wall-clock budget for one refresh. Generous by default — a real pull is
// minutes — but bounded so a stalled source cannot run indefinitely.
const feedDeadlineMs = Number(process.env.WORKER_FEED_DEADLINE_MS ?? 900_000);
if (feedSchedules.length > 0) {
  console.info(
    JSON.stringify({
      event: "feed.schedule.configured",
      feeds: feedSchedules.map((f) => ({
        name: f.name,
        atUtc: `${String(f.hourUtc).padStart(2, "0")}:${String(f.minuteUtc).padStart(2, "0")}`,
      })),
    }),
  );
}
let stopping = false;
let nextReaperAt = 0;
let inFlightFeed: Promise<void> | null = null;

/**
 * Run any feed whose scheduled time has arrived today.
 *
 * A feed failure must never take the worker down: the outbox is the worker's
 * primary job, and a refresh that cannot reach Acumatica is a reason to log and
 * retry tomorrow, not to stop processing approvals. The run is marked before
 * the work so a feed that fails does not retry in a tight loop for the rest of
 * the day; intake is idempotent per aging date, so the next day's run is clean.
 */
/**
 * Reject if a promise has not settled in time.
 *
 * The connector's per-request timeout bounds each HTTP call, but not a whole
 * run: a source that stays slow across many pages can still run for hours. A
 * daily refresh that has not finished within its budget is a failure to log
 * and retry tomorrow, not something to keep waiting on.
 */
async function withDeadline<T>(
  ms: number,
  label: string,
  work: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its ${ms}ms budget`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runDueFeeds(
  due: ReturnType<FeedRunLog["due"]>,
  now: Date,
): Promise<void> {
  for (const schedule of due) {
    feedRunLog.record(schedule.name, now);
    const traceId = `feed-${schedule.name}-${randomUUID()}`;
    const startedAt = Date.now();
    try {
      const summary = await withDeadline(
        feedDeadlineMs,
        `feed ${schedule.name}`,
        schedule.name === "collections"
          ? runCollectionsFeed(pool).then((result) => ({
              readInvoices: result.readInvoices,
              readCustomers: result.readCustomers,
              customersWithEmail: result.customersWithEmail,
              created: result.perCompany.reduce((n, r) => n + r.created, 0),
              replayed: result.perCompany.reduce((n, r) => n + r.replayed, 0),
              proposed: result.perCompany.reduce((n, r) => n + r.proposed, 0),
              unaddressable: result.perCompany.reduce(
                (n, r) => n + r.unaddressable,
                0,
              ),
              skipped: result.perCompany.reduce(
                (n, r) => n + r.skipped.length,
                0,
              ),
            }))
          : runSalesFeed(pool).then((result) => ({
              created: result.perSource.reduce((n, r) => n + r.created, 0),
              replayed: result.perSource.reduce((n, r) => n + r.replayed, 0),
              skipped: result.perSource.reduce(
                (n, r) => n + r.skipped.length,
                0,
              ),
            })),
      );
      console.info(
        JSON.stringify({
          event: "feed.refresh.completed",
          feed: schedule.name,
          traceId,
          durationMs: Date.now() - startedAt,
          ...summary,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "feed.refresh.failed",
          feed: schedule.name,
          traceId,
          durationMs: Date.now() - startedAt,
          message:
            error instanceof Error ? error.message : "Unknown feed error",
        }),
      );
    }
  }
}

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
    maybeStartDueFeeds(new Date());
    const result = await processNextOutboxJob(
      pool,
      workerId,
      executionProvider,
      mailDraftProvider,
      credentialRuntime,
    );
    if (result === "idle") {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

/**
 * Start any due feed WITHOUT blocking the loop.
 *
 * A feed pull is minutes of network and database work; awaiting it inline would
 * stop the worker from processing approvals for that whole time, and a hung
 * Acumatica call (40 pages x a 30s timeout) could freeze the queue for far
 * longer. Approvals are the worker's job — a refresh must never stand in front
 * of them. The in-flight guard keeps one refresh running at a time, and the
 * run is marked before the work so a failure waits for tomorrow rather than
 * retrying in a tight loop.
 */
function maybeStartDueFeeds(now: Date): void {
  if (feedSchedules.length === 0 || inFlightFeed) return;
  const due = feedRunLog.due(feedSchedules, now);
  if (due.length === 0) return;
  // Keep the handle so shutdown can wait for it, and swallow nothing silently:
  // an unhandled rejection here would terminate the worker outright.
  inFlightFeed = runDueFeeds(due, now)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "feed.refresh.crashed",
          message:
            error instanceof Error ? error.message : "Unknown feed error",
        }),
      );
    })
    .finally(() => {
      inFlightFeed = null;
    });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  await loop();
} finally {
  // Let an in-flight refresh finish before the pool is destroyed, or its open
  // transaction commits against a dead pool mid-run. Bounded, so a hung feed
  // delays shutdown by at most the grace period instead of blocking it.
  if (inFlightFeed) {
    const graceMs = Number(process.env.WORKER_FEED_SHUTDOWN_GRACE_MS ?? 15_000);
    await Promise.race([
      inFlightFeed,
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }
  await pool.end();
}
