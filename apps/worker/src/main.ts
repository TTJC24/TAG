import { randomUUID } from "node:crypto";
import {
  assertWorkerDatabaseIdentity,
  createDatabasePool,
} from "@operating-layer/db";
import {
  assertGmailCredentialStartup,
  DisabledOAuthTokenRevoker,
  FeedRunLog,
  GoogleOAuthTokenRevoker,
  IDEMPOTENCY_REAPER_INTERVAL_MS,
  processNextOutboxJob,
  reapExpiredIdempotencyKeys,
  resolveFeedSchedules,
  runCollectionsFeed,
  runSalesFeed,
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
// Scheduled feed refreshes. Empty unless *_SCHEDULE_UTC is set explicitly, so
// this ships inert and an unconfigured deploy behaves exactly as before.
const feedSchedules = resolveFeedSchedules();
const feedRunLog = new FeedRunLog();
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
let feedInFlight = false;

/**
 * Run any feed whose scheduled time has arrived today.
 *
 * A feed failure must never take the worker down: the outbox is the worker's
 * primary job, and a refresh that cannot reach Acumatica is a reason to log and
 * retry tomorrow, not to stop processing approvals. The run is marked before
 * the work so a feed that fails does not retry in a tight loop for the rest of
 * the day; intake is idempotent per aging date, so the next day's run is clean.
 */
async function runDueFeeds(
  due: ReturnType<FeedRunLog["due"]>,
  now: Date,
): Promise<void> {
  for (const schedule of due) {
    feedRunLog.record(schedule.name, now);
    const traceId = `feed-${schedule.name}-${randomUUID()}`;
    const startedAt = Date.now();
    try {
      const summary =
        schedule.name === "collections"
          ? await runCollectionsFeed(pool).then((result) => ({
              readInvoices: result.readInvoices,
              readCustomers: result.readCustomers,
              customersWithEmail: result.customersWithEmail,
              created: result.perCompany.reduce((n, r) => n + r.created, 0),
              replayed: result.perCompany.reduce((n, r) => n + r.replayed, 0),
              unaddressable: result.perCompany.reduce(
                (n, r) => n + r.unaddressable,
                0,
              ),
              skipped: result.perCompany.reduce(
                (n, r) => n + r.skipped.length,
                0,
              ),
            }))
          : await runSalesFeed(pool).then((result) => ({
              created: result.perSource.reduce((n, r) => n + r.created, 0),
              replayed: result.perSource.reduce((n, r) => n + r.replayed, 0),
              skipped: result.perSource.reduce(
                (n, r) => n + r.skipped.length,
                0,
              ),
            }));
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
          message: error instanceof Error ? error.message : "Unknown feed error",
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
      gmailDraftProvider,
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
  if (feedSchedules.length === 0 || feedInFlight) return;
  const due = feedRunLog.due(feedSchedules, now);
  if (due.length === 0) return;
  feedInFlight = true;
  void runDueFeeds(due, now).finally(() => {
    feedInFlight = false;
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
  await pool.end();
}
