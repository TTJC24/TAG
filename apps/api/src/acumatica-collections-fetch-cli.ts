import { createDatabasePool } from "@operating-layer/db";
import { AcumaticaClient } from "@operating-layer/connectors";
import {
  buildAgingFromInvoices,
  loadOrganizationIdsByCode,
  resolveCollectionsConfig,
  syncArAging,
} from "@operating-layer/issue-intake";

/**
 * Operator command: read open AR live from Acumatica, age it, and run it
 * through the Collections doorway. Acumatica is the source of truth — this is
 * the live replacement for the aging-file path.
 *
 *   node dist/acumatica-collections-fetch-cli.js
 *   (or: pnpm --filter @operating-layer/api acumatica-collections:fetch)
 *
 * One Production tenant; FS and BLC are branches, so the read is split into
 * per-company aging (FS -> FS, BLC -> BLCS) and each runs through the doorway.
 * Read-only: the connector only reads AR (plus its own auth login/logout).
 *
 * Inert unless explicitly configured:
 *   COLLECTIONS_ENABLED=true
 *   COLLECTIONS_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 *   ACUMATICA_BASE_URL=https://bigleaguecs.acumatica.com
 *   ACUMATICA_USERNAME=<read-only api user>
 *   ACUMATICA_PASSWORD=<read-only api user password>
 *   ACUMATICA_COMPANY=Production
 * Optional: ACUMATICA_ENDPOINT_VERSION (default 24.200.001), COLLECTIONS_ASOF.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const config = resolveCollectionsConfig();
  const operatingUrl = required("DATABASE_URL");
  const client = new AcumaticaClient({
    baseUrl: required("ACUMATICA_BASE_URL"),
    username: required("ACUMATICA_USERNAME"),
    password: required("ACUMATICA_PASSWORD"),
    company: process.env.ACUMATICA_COMPANY ?? "Production",
    ...(process.env.ACUMATICA_ENDPOINT_VERSION
      ? { endpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION }
      : {}),
  });
  const asOf =
    process.env.COLLECTIONS_ASOF ?? new Date().toISOString().slice(0, 10);

  await client.login();
  let invoices;
  try {
    invoices = await client.fetchOpenArInvoices();
  } finally {
    await client.logout();
  }
  console.error(`read ${invoices.length} open AR documents from Acumatica`);

  const agingByCompany = buildAgingFromInvoices(invoices, asOf);
  const pool = createDatabasePool(operatingUrl);
  let anySkipped = false;
  try {
    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    for (const aging of agingByCompany) {
      const result = await syncArAging(pool, aging, config, organizationIdsByCode);
      if (result.skipped.length > 0) anySkipped = true;
      console.log(
        JSON.stringify(
          { company: aging.company, customers: aging.customers.length, ...result },
          null,
          2,
        ),
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
