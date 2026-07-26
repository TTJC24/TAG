import { readFileSync } from "node:fs";
import { createDatabasePool } from "@operating-layer/db";
import {
  loadOrganizationIdsByCode,
  parseArAgingDetailed,
  parseCsvGrid,
  resolveCollectionsConfig,
  syncArAging,
} from "@operating-layer/issue-intake";

/**
 * Operator command: run an AR aging export through the Collections doorway.
 *
 *   node dist/collections-cli.js <aging-export.csv>
 *   (or: pnpm --filter @operating-layer/api collections:sync <file>)
 *
 * Each past-due customer becomes a governed chase on the right ladder rung,
 * overdue invoices itemized, for the AR person to approve. Nothing sends.
 *
 * Inert unless explicitly configured:
 *   COLLECTIONS_ENABLED=true
 *   COLLECTIONS_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 * Optional:
 *   COLLECTIONS_MIN_PAST_DUE=25          (skip trivial balances)
 *   COLLECTIONS_ORG_CODE=FSI             (force the org; else derived from the
 *                                         export's Company/Branch via the FS->FSI
 *                                         boundary map)
 *
 * Export the report from Acumatica as CSV (AR Aging - Detailed). Re-running the
 * same file replays (idempotent per customer + aging date); next week's file
 * raises fresh chases.
 */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    throw new Error("usage: collections-cli <aging-export.csv>");
  }
  const config = resolveCollectionsConfig();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) {
    throw new Error("DATABASE_URL (operating-layer) is required");
  }

  const grid = parseCsvGrid(readFileSync(file, "utf8"));
  const parsed = parseArAgingDetailed(grid);
  if (parsed.customers.length === 0) {
    throw new Error(
      "No customers parsed — is this an Acumatica 'AR Aging (Detailed)' CSV export?",
    );
  }

  const pool = createDatabasePool(operatingUrl);
  try {
    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    const orgCode = process.env.COLLECTIONS_ORG_CODE;
    const result = await syncArAging(
      pool,
      parsed,
      config,
      organizationIdsByCode,
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
