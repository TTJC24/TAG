import { readFileSync } from "node:fs";
import { createDatabasePool } from "@operating-layer/db";
import {
  loadOrganizationIdsByCode,
  resolvePipedriveSalesConfig,
  syncPipedriveDeals,
} from "@operating-layer/issue-intake";

/**
 * Operator command: run Pipedrive deals through the Sales doorway.
 *
 *   node dist/pipedrive-sales-cli.js <deals.json>
 *   (or: pnpm --filter @operating-layer/api pipedrive-sales:sync <file>)
 *
 * <deals.json> is a JSON array of Pipedrive deal objects (a saved export, or
 * the payload the Pipedrive connector will supply once its read is enabled).
 * Deals that are adrift — past expected close, gone quiet, or with no next step
 * — become governed follow-ups in the tower. Pipedrive stays canonical; nothing
 * is written back to it.
 *
 * Inert unless explicitly configured:
 *   PIPEDRIVE_SALES_ENABLED=true
 *   PIPEDRIVE_SALES_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 * Optional:
 *   PIPEDRIVE_SALES_STALE_DAYS=14
 *   PIPEDRIVE_PIPELINE_ORG_MAP='{"1":"FS","2":"BLCS"}'   (pipeline_id -> org)
 *   PIPEDRIVE_SALES_ORG_CODE=FS                          (force one org)
 *   PIPEDRIVE_SALES_ASOF=2026-07-26                      (scan date; else today)
 */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    throw new Error("usage: pipedrive-sales-cli <deals.json>");
  }
  const config = resolvePipedriveSalesConfig();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) {
    throw new Error("DATABASE_URL (operating-layer) is required");
  }

  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const deals: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : [];
  if (deals.length === 0) {
    throw new Error("No deals found — expected a JSON array of Pipedrive deals.");
  }

  const asOf =
    process.env.PIPEDRIVE_SALES_ASOF ?? new Date().toISOString().slice(0, 10);
  const pool = createDatabasePool(operatingUrl);
  try {
    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    const orgCode = process.env.PIPEDRIVE_SALES_ORG_CODE;
    const result = await syncPipedriveDeals(
      pool,
      deals,
      config,
      organizationIdsByCode,
      asOf,
      orgCode ? { orgCode } : {},
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.skipped.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
