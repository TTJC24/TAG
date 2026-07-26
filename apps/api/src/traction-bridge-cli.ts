import { createDatabasePool } from "@operating-layer/db";
import {
  loadOrganizationIdsByCode,
  resolveTractionBridgeConfig,
  syncTractionIssues,
} from "@operating-layer/issue-intake";

/**
 * Operator command: sync flagged TractionOS meeting issues into intake.
 *
 *   pnpm traction-bridge:sync
 *
 * Inert unless explicitly configured:
 *   TRACTION_BRIDGE_ENABLED=true
 *   TRACTION_DATABASE_URL=postgresql://... (a READ-ONLY role is expected)
 *   TRACTION_BRIDGE_STATUSES=tabled
 *   TRACTION_BRIDGE_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 * Optional:
 *   TRACTION_BRIDGE_ORG_CODE_MAP='{"FS":"FS","BL":"BLCS","USA":"USA"}'
 *   TRACTION_BRIDGE_BATCH_LIMIT=100
 *
 * The bridge additionally forces its Traction session read-only; the live
 * meeting tool is never written to. Re-runs are idempotent.
 */
async function main(): Promise<void> {
  const config = resolveTractionBridgeConfig();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) {
    throw new Error("DATABASE_URL (operating-layer) is required");
  }
  const operatingPool = createDatabasePool(operatingUrl);
  const tractionPool = createDatabasePool(config.tractionDatabaseUrl);
  try {
    const organizationIdsByCode =
      await loadOrganizationIdsByCode(operatingPool);
    const result = await syncTractionIssues(
      operatingPool,
      tractionPool,
      config,
      organizationIdsByCode,
    );
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          created: result.created,
          replayed: result.replayed,
          skipped: result.skipped,
        },
        null,
        2,
      ),
    );
    if (result.skipped.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await tractionPool.end();
    await operatingPool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
