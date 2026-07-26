import { writeFileSync } from "node:fs";
import { createDatabasePool } from "@operating-layer/db";
import {
  generateMorningBrief,
  resolveApplicationPrincipal,
} from "@operating-layer/issue-intake";

/**
 * Operator command: write the machine-generated morning brief.
 *
 *   pnpm brief:generate [--out path/to/brief.md]
 *
 * Requires:
 *   DATABASE_URL=<operating-layer runtime database>
 *   BRIEF_USER_EMAIL=<provisioned operating-layer user>
 *
 * Renders live state (queue, approvals, failures, outcomes) for every
 * organization the user can read, as Obsidian-ready markdown. Without --out
 * the brief prints to stdout. Read-only over system state.
 */
async function main(): Promise<void> {
  const operatingUrl = process.env.DATABASE_URL;
  const email = process.env.BRIEF_USER_EMAIL;
  if (!operatingUrl) throw new Error("DATABASE_URL is required");
  if (!email) throw new Error("BRIEF_USER_EMAIL is required");
  const outIndex = process.argv.indexOf("--out");
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outPath) throw new Error("--out requires a path");

  const pool = createDatabasePool(operatingUrl);
  try {
    const principal = await resolveApplicationPrincipal(pool, {
      issuer: "brief-cli",
      subject: email,
      email,
    });
    const brief = await generateMorningBrief(pool, principal);
    if (outPath) {
      writeFileSync(outPath, brief);
      console.log(`brief written to ${outPath}`);
    } else {
      console.log(brief);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
