import { createDatabasePool } from "@operating-layer/db";
import { AcumaticaClient, PipedriveClient } from "@operating-layer/connectors";
import {
  buildAgingFromInvoices,
  buildCollectionsDrafts,
  checkAcumatica,
  checkMailWire,
  checkPipedriveSource,
  checkPlatform,
  renderReport,
  resolvePipedriveSources,
  summarize,
  type CheckResult,
} from "@operating-layer/issue-intake";

/**
 * Operator command: does this thing actually work against the real systems?
 *
 *   node apps/api/dist/preflight-cli.js            # check every wire
 *   node apps/api/dist/preflight-cli.js --dry-run  # + show what WOULD be raised
 *
 * READ-ONLY and safe to run repeatedly, including in production. It creates
 * nothing, sends nothing, and enqueues nothing. Exit code 0 when no check
 * failed, 1 when something failed, so it can be wired into a scheduled health
 * check later.
 *
 * A wire that is not configured is reported as SKIP, not FAIL — the point is an
 * honest picture of what is live, not a demand that everything be on.
 */

function envFlag(name: string): boolean {
  return process.env[name] === "true";
}

/** Preview what Collections would raise. Reads only; writes nothing. */
async function runDryRun(client: AcumaticaClient): Promise<void> {
  // Reuses the session checkAcumatica opened. Logging in again here would hold
  // two concurrent sessions for one command, against a server that caps them.
  const invoices = await client.fetchOpenArInvoices();
  const contacts = await client.fetchCustomers();
  const asOf =
    process.env.COLLECTIONS_ASOF ?? new Date().toISOString().slice(0, 10);
  const aging = buildAgingFromInvoices(invoices, asOf, { contacts });

  console.log("\n══ DRY RUN — what Collections would raise ══");
  console.log("(nothing below has been created; this is a preview)\n");
  for (const company of aging) {
    const drafts = buildCollectionsDrafts(company, {
      minPastDue: Number.parseFloat(
        process.env.COLLECTIONS_MIN_PAST_DUE ?? "0",
      ),
    });
    const total = drafts.reduce((sum, d) => sum + d.pastDue, 0);
    const addressable = drafts.filter((d) => d.email.recipient).length;
    const byStep = drafts.reduce<Record<number, number>>((acc, d) => {
      acc[d.step] = (acc[d.step] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `${company.company}: ${drafts.length} chases · ${money(total)} past due (net of credits)`,
    );
    console.log(
      `  addressable ${addressable}/${drafts.length} · by ladder step ${JSON.stringify(byStep)}`,
    );
    for (const d of [...drafts]
      .sort((a, b) => b.pastDue - a.pastDue)
      .slice(0, 5)) {
      console.log(
        `    ${money(d.pastDue).padStart(14)}  step ${d.step}  ${d.customerName}${d.email.recipient ? "" : "  [no email on file]"}`,
      );
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const results: CheckResult[] = [];

  // --- platform -----------------------------------------------------------
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  const pool = createDatabasePool(databaseUrl);

  try {
    const serviceUserEmail =
      process.env.PREFLIGHT_USER_EMAIL ?? process.env.COLLECTIONS_USER_EMAIL;
    results.push(
      ...(await checkPlatform(pool, {
        ...(serviceUserEmail ? { serviceUserEmail } : {}),
      })),
    );

    // --- acumatica --------------------------------------------------------
    const acumaticaConfigured =
      Boolean(process.env.ACUMATICA_BASE_URL) &&
      Boolean(process.env.ACUMATICA_USERNAME) &&
      Boolean(process.env.ACUMATICA_PASSWORD);

    if (!acumaticaConfigured) {
      results.push({
        section: "acumatica",
        name: "configuration",
        status: "skip",
        detail: "ACUMATICA_BASE_URL / USERNAME / PASSWORD not set",
      });
    } else {
      const client = new AcumaticaClient({
        baseUrl: process.env.ACUMATICA_BASE_URL!,
        username: process.env.ACUMATICA_USERNAME!,
        password: process.env.ACUMATICA_PASSWORD!,
        company: process.env.ACUMATICA_COMPANY ?? "Production",
        ...(process.env.ACUMATICA_ENDPOINT_VERSION
          ? { endpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION }
          : {}),
      });
      const acumaticaResults = await checkAcumatica(client, {
        keepSessionOpen: dryRun,
      });
      results.push(...acumaticaResults);
      // Only preview if we actually got in. Running it against a session that
      // was never established just produces a second, misleading failure (a 401
      // that looks like a permissions problem rather than the login it was).
      const authenticated =
        acumaticaResults.find((r) => r.name === "authenticates")?.status ===
        "pass";

      // Dry run: show exactly what Collections WOULD raise, writing nothing.
      //
      // Fault-isolated deliberately. This runs BEFORE the report is printed, so
      // an unhandled failure here would discard every check that already
      // passed — which is exactly what a preflight must never do.
      if (dryRun && authenticated) {
        try {
          await runDryRun(client);
        } catch (error) {
          results.push({
            section: "acumatica",
            name: "dry run",
            status: "fail",
            detail: `preview failed: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          });
        } finally {
          // The checks handed us the session; releasing it is ours to do.
          await client.logout();
        }
      } else if (dryRun) {
        results.push({
          section: "acumatica",
          name: "dry run",
          status: "skip",
          detail: "skipped because authentication failed",
        });
      }
    }

    // --- pipedrive --------------------------------------------------------
    let sources: ReturnType<typeof resolvePipedriveSources> = [];
    try {
      sources = resolvePipedriveSources();
    } catch {
      sources = [];
    }
    if (sources.length === 0) {
      results.push({
        section: "pipedrive",
        name: "configuration",
        status: "skip",
        detail: "PIPEDRIVE_SOURCES not set or unparseable",
      });
    } else {
      for (const source of sources) {
        const client = new PipedriveClient({
          apiBase: source.apiBase,
          apiToken: source.token,
        });
        results.push(
          ...(await checkPipedriveSource(source.name, client, {
            ...(source.orgCode ? { orgCode: source.orgCode } : {}),
            ...(source.pipelineToOrgCode
              ? { pipelineToOrgCode: source.pipelineToOrgCode }
              : {}),
          })),
        );
      }
    }

    // --- mail -------------------------------------------------------------
    results.push(...checkMailWire(process.env));

    // --- doorway switches -------------------------------------------------
    for (const [name, flag] of [
      ["collections", "COLLECTIONS_ENABLED"],
      ["sales (pipedrive)", "PIPEDRIVE_SALES_ENABLED"],
    ] as const) {
      results.push({
        section: "doorways",
        name,
        status: envFlag(flag) ? "pass" : "skip",
        detail: envFlag(flag)
          ? `enabled via ${flag}`
          : `inert (${flag} not "true")`,
      });
    }
    for (const [name, flag] of [
      ["collections schedule", "COLLECTIONS_SCHEDULE_UTC"],
      ["sales schedule", "SALES_SCHEDULE_UTC"],
    ] as const) {
      const value = process.env[flag];
      results.push({
        section: "doorways",
        name,
        status: value ? "pass" : "skip",
        detail: value ? `runs daily at ${value} UTC` : "no schedule set",
      });
    }
  } finally {
    await pool.end();
  }

  const report = summarize(results);
  console.log(renderReport(report));
  if (!report.ok) process.exitCode = 1;
}

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
