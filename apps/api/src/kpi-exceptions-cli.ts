import { readFileSync } from "node:fs";
import { createDatabasePool } from "@operating-layer/db";
import { CompanyBrainQueryClient } from "@operating-layer/connectors";
import {
  kpiExceptionDefinitionsFileSchema,
  loadOrganizationIdsByCode,
  resolveKpiExceptionConfig,
  scanKpiExceptions,
} from "@operating-layer/issue-intake";

/**
 * Operator command: run certified KPI exception definitions against
 * company-brain's read-only query service and raise governed issues.
 *
 *   pnpm kpi-exceptions:scan <definitions.json>
 *
 * Inert unless explicitly configured:
 *   KPI_EXCEPTIONS_ENABLED=true
 *   BRAIN_QUERY_URL=http://...   (company-brain query service)
 *   KPI_EXCEPTIONS_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 * Development only:
 *   KPI_EXCEPTIONS_ALLOW_UNCERTIFIED=true
 */
async function main(): Promise<void> {
  const definitionsPath = process.argv[2];
  if (!definitionsPath) {
    throw new Error("usage: kpi-exceptions-cli <definitions.json>");
  }
  const config = resolveKpiExceptionConfig();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) {
    throw new Error("DATABASE_URL (operating-layer) is required");
  }
  const parsedFile = kpiExceptionDefinitionsFileSchema.parse(
    JSON.parse(readFileSync(definitionsPath, "utf8")),
  );
  const operatingPool = createDatabasePool(operatingUrl);
  const queryClient = new CompanyBrainQueryClient({
    baseUrl: config.brainQueryUrl,
  });
  try {
    const organizationIdsByCode =
      await loadOrganizationIdsByCode(operatingPool);
    const result = await scanKpiExceptions(
      operatingPool,
      queryClient,
      parsedFile.definitions,
      organizationIdsByCode,
      {
        serviceUserEmail: config.serviceUserEmail,
        allowUncertified: config.allowUncertified,
      },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await operatingPool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
