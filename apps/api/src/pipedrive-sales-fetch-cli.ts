import { createDatabasePool } from "@operating-layer/db";
import { PipedriveClient } from "@operating-layer/connectors";
import {
  loadOrganizationIdsByCode,
  resolvePipedriveSalesConfig,
  resolvePipedriveSources,
  syncPipedriveDeals,
} from "@operating-layer/issue-intake";

/**
 * Operator command: pull deals live from every configured Pipedrive account
 * and run them through the Sales doorway.
 *
 *   node dist/pipedrive-sales-fetch-cli.js
 *   (or: pnpm --filter @operating-layer/api pipedrive-sales:fetch)
 *
 * The group runs two Pipedrive accounts — one holds FS (routes wholesale to
 * FS), the other holds BL + USA (routed by pipeline). Each is a read-only
 * source; nothing is ever written back to Pipedrive.
 *
 * Inert unless explicitly configured:
 *   PIPEDRIVE_SALES_ENABLED=true
 *   PIPEDRIVE_SALES_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 *   PIPEDRIVE_SOURCES=[
 *     {"name":"FS","apiBase":"https://<fs>.pipedrive.com",
 *      "tokenEnv":"PIPEDRIVE_TOKEN_FS","orgCode":"FS"},
 *     {"name":"BL-USA","apiBase":"https://<blusa>.pipedrive.com",
 *      "tokenEnv":"PIPEDRIVE_TOKEN_BLUSA",
 *      "pipelineToOrgCode":{"<bl_pipeline_id>":"BLCS","<usa_pipeline_id>":"USA"}}
 *   ]
 *   PIPEDRIVE_TOKEN_FS=...        (read-only)
 *   PIPEDRIVE_TOKEN_BLUSA=...     (read-only)
 * Optional: PIPEDRIVE_SALES_STALE_DAYS, PIPEDRIVE_SALES_ASOF.
 *
 * On first run, any deal whose pipeline isn't in the map is reported as skipped
 * with its pipeline id — use that to fill in PIPEDRIVE_PIPELINE ids for BL/USA.
 */
async function main(): Promise<void> {
  const config = resolvePipedriveSalesConfig();
  const sources = resolvePipedriveSources();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) {
    throw new Error("DATABASE_URL (operating-layer) is required");
  }
  const asOf =
    process.env.PIPEDRIVE_SALES_ASOF ?? new Date().toISOString().slice(0, 10);

  const pool = createDatabasePool(operatingUrl);
  let anySkipped = false;
  try {
    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    for (const source of sources) {
      const client = new PipedriveClient({
        apiBase: source.apiBase,
        apiToken: source.token,
      });
      const deals = await client.fetchOpenDeals();

      // Discovery aid: show the pipelines this account actually contains, so
      // the BL/USA pipeline->org map can be filled in from real ids.
      const pipelines = new Map<string, number>();
      for (const deal of deals) {
        const key = String(deal.pipeline_id ?? "none");
        pipelines.set(key, (pipelines.get(key) ?? 0) + 1);
      }
      console.error(
        `[${source.name}] pipelines seen (id: open deals): ` +
          [...pipelines.entries()].map(([id, n]) => `${id}: ${n}`).join(", "),
      );

      const result = await syncPipedriveDeals(
        pool,
        deals,
        config,
        organizationIdsByCode,
        asOf,
        {
          ...(source.orgCode ? { orgCode: source.orgCode } : {}),
          ...(source.pipelineToOrgCode
            ? { pipelineToOrgCode: source.pipelineToOrgCode }
            : {}),
        },
      );
      if (result.skipped.length > 0) anySkipped = true;
      console.log(JSON.stringify({ source: source.name, ...result }, null, 2));
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
