import { readFileSync } from "node:fs";
import { createDatabasePool } from "@operating-layer/db";
import {
  demandstarMessagesFileSchema,
  loadOrganizationIdsByCode,
  resolveDemandstarBridgeConfig,
  syncDemandstarBids,
} from "@operating-layer/issue-intake";

/**
 * Operator command: feed exported DemandStar bid emails into governed intake.
 *
 *   pnpm demandstar:sync <messages.json>
 *
 * messages.json: { "messages": [{ id, subject, from, date, body }, ...] }
 * (body may be the raw HTML email body).
 *
 * Inert unless explicitly configured:
 *   DEMANDSTAR_BRIDGE_ENABLED=true
 *   DEMANDSTAR_BRIDGE_USER_EMAIL=<provisioned operating-layer user>
 *   DATABASE_URL=<operating-layer runtime database>
 * Optional:
 *   DEMANDSTAR_BRIDGE_ENTITY_CODE=USA (default)
 *   DEMANDSTAR_BRIDGE_SENDER_DOMAIN=demandstar.com (default)
 */
async function main(): Promise<void> {
  const messagesPath = process.argv[2];
  if (!messagesPath) {
    throw new Error("usage: demandstar-cli <messages.json>");
  }
  const config = resolveDemandstarBridgeConfig();
  const operatingUrl = process.env.DATABASE_URL;
  if (!operatingUrl) throw new Error("DATABASE_URL is required");
  const parsed = demandstarMessagesFileSchema.parse(
    JSON.parse(readFileSync(messagesPath, "utf8")),
  );
  const pool = createDatabasePool(operatingUrl);
  try {
    const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
    const result = await syncDemandstarBids(
      pool,
      parsed.messages,
      config,
      organizationIdsByCode,
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
