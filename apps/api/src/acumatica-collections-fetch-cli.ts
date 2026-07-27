import { createDatabasePool } from "@operating-layer/db";
import { runCollectionsFeed } from "@operating-layer/issue-intake";

/**
 * Operator command: read open AR live from Acumatica, age it, and run it
 * through the Collections doorway. Acumatica is the source of truth — this is
 * the live replacement for the aging-file path.
 *
 *   node apps/api/dist/acumatica-collections-fetch-cli.js
 *
 * The pull itself lives in runCollectionsFeed, which the scheduled worker also
 * calls — so running this by hand and letting the schedule run it are the same
 * code path, not two implementations that can drift.
 *
 * One Production tenant; FS and BLC are branches, so the read is split into
 * per-company aging (FS -> FS, BLC -> BLCS) and each runs through the doorway.
 * Read-only: the connector only reads AR and customers (plus its own auth
 * login/logout), and every chase it raises still needs human approval.
 *
 * Inert unless explicitly configured:
 *   COLLECTIONS_ENABLED=true
 *   COLLECTIONS_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 *   ACUMATICA_BASE_URL=https://bigleaguecs.acumatica.com
 *   ACUMATICA_USERNAME=<read-only api user>
 *   ACUMATICA_PASSWORD=<read-only api user password>
 *   ACUMATICA_COMPANY=Production
 * Optional: ACUMATICA_ENDPOINT_VERSION (default 24.200.001), COLLECTIONS_ASOF,
 *   COLLECTIONS_SENDER_NAME / COLLECTIONS_SENDER_CONTACT (chase signature).
 */
async function main(): Promise<void> {
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) throw new Error("DATABASE_URL is required");

  const pool = createDatabasePool(operatingUrl);
  let anySkipped = false;
  try {
    const result = await runCollectionsFeed(pool);
    console.error(
      `read ${result.readInvoices} open AR documents, ${result.readCustomers} customers (${result.customersWithEmail} with an AR email on file)`,
    );
    for (const company of result.perCompany) {
      if (company.skipped.length > 0) anySkipped = true;
      console.log(JSON.stringify(company, null, 2));
    }
    const unaddressable = result.perCompany.reduce(
      (n, r) => n + r.unaddressable,
      0,
    );
    if (unaddressable > 0) {
      console.error(
        `${unaddressable} chase(s) have no AR contact email in Acumatica and must be addressed by hand`,
      );
    }
  } finally {
    await pool.end();
  }
  if (anySkipped) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
