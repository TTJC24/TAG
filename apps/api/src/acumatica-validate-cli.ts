import {
  AcumaticaClient,
  resolveAcumaticaGuard,
  withAcumaticaRunLock,
} from "@operating-layer/connectors";

/**
 * Controlled production validation. One login, one harmless read, then stop.
 *
 *   node apps/api/dist/acumatica-validate-cli.js --step 1 --operator "Tim Clark"
 *
 * This is the only command permitted to authenticate against production while
 * the lockout mechanism is unproven. It is modelled directly on company-brain's
 * `acumatica:readiness` check, which has run against this same tenant without
 * incident — see docs/acumatica-integration-comparison.md.
 *
 * The rules it enforces, each one from the operator's instructions:
 *
 *  - It will not run without an explicit --operator name. Every production
 *    login is an attributable act.
 *  - It performs EXACTLY ONE login. The client latches after one attempt, so a
 *    second is impossible even if this file were changed to ask for one.
 *  - It STOPS ON THE FIRST NON-SUCCESS RESPONSE and reports it verbatim.
 *    Nothing is retried, nothing is "worked around", and no further request is
 *    sent after a failure of any kind.
 *  - Reads are added ONE STEP AT A TIME, and a step will not run until the
 *    previous step has been confirmed clean by an operator.
 *
 * After each run, check Acumatica's failed-login counter and Access History
 * before running the next step. That check is the actual experiment; this
 * command only produces the single request it needs.
 */

const STEPS = [
  {
    n: 1,
    label: "login only",
    detail:
      "Authenticate and log out. No entity is read. This isolates the login " +
      "itself: if the failed-login counter moves after this, the cause is the " +
      "login, not any read.",
    read: null,
  },
  {
    n: 2,
    label: "Customer $top=1",
    detail:
      "The smallest possible read, and the exact shape company-brain's " +
      "readiness check performs against this tenant without incident.",
    read: { entity: "Customer", top: 1 },
  },
  {
    n: 3,
    label: "Invoice $top=1",
    detail:
      "First read of the AR entity Collections actually depends on, still " +
      "capped at one record and with no $filter or $select.",
    read: { entity: "Invoice", top: 1 },
  },
] as const;

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function usage(): void {
  console.log("Controlled Acumatica production validation\n");
  for (const step of STEPS) {
    console.log(`  --step ${step.n}   ${step.label}`);
    console.log(`             ${step.detail}\n`);
  }
  console.log('Run:  --step <n> --operator "Your Name"\n');
  console.log(
    "After EACH step, check Acumatica Access History and the account's failed\n" +
      "attempt counter before running the next one. Do not skip ahead.",
  );
}

async function main(): Promise<void> {
  const operator = arg("--operator");
  const stepArg = arg("--step");
  if (!stepArg || !operator) {
    usage();
    if (!operator && stepArg) {
      console.error("\n--operator is required: this is an attributable act");
    }
    process.exitCode = 2;
    return;
  }

  const step = STEPS.find((s) => String(s.n) === stepArg);
  if (!step) {
    console.error(`unknown step "${stepArg}"`);
    process.exitCode = 2;
    return;
  }

  const guard = resolveAcumaticaGuard();
  const state = guard.breaker.read();
  console.log(`operator    : ${operator}`);
  console.log(`environment : ${guard.environment}`);
  console.log(`step        : ${step.n} — ${step.label}`);
  console.log(`breaker     : ${state.tripped ? "TRIPPED" : "clear"}`);
  if (state.tripped) {
    console.error(
      `\nRefusing to run: the breaker is tripped (${state.kind}): ${state.reason}\n` +
        `Clear it deliberately with acumatica-breaker-cli only after confirming\n` +
        `the ERP account itself is not locked.`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new AcumaticaClient({
    baseUrl: required("ACUMATICA_BASE_URL"),
    username: required("ACUMATICA_USERNAME"),
    password: required("ACUMATICA_PASSWORD"),
    company: process.env.ACUMATICA_COMPANY ?? "Production",
    breaker: guard.breaker,
    ...(process.env.ACUMATICA_ENDPOINT_VERSION
      ? { endpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION }
      : {}),
  });

  await withAcumaticaRunLock(guard, `validate-step-${step.n}`, async () => {
    console.log("\n→ POST /entity/auth/login (the only login this run)");
    await client.login();
    console.log("  login OK");

    try {
      if (step.read) {
        console.log(
          `\n→ GET ${step.read.entity}?$top=${step.read.top} (the only read this run)`,
        );
        const rows = await client.probeEntity(step.read.entity, step.read.top);
        console.log(`  read OK — ${rows.length} record(s)`);
      }
    } finally {
      // Always release the session. Acumatica caps concurrent Contract API
      // sessions per user, and an abandoned session consumes a seat until it
      // times out — which is a way to cause the next run's failure.
      console.log("\n→ POST /entity/auth/logout");
      await client.logout();
      console.log("  session released");
    }
  });

  console.log(
    `\nStep ${step.n} completed with no non-success response.\n\n` +
      `NOW, before running step ${step.n + 1}:\n` +
      `  1. Acumatica → Access History: confirm exactly one login for this user.\n` +
      `  2. Acumatica → Users: confirm the failed-attempt counter did NOT move.\n` +
      `  3. Only if both are clean, run the next step.`,
  );
}

main().catch((error) => {
  // Stop on the first non-success response and report it verbatim. No retry,
  // no fallback, no second request — the message is the finding.
  console.error(
    `\nSTOPPED on first failure:\n  ${
      error instanceof Error ? error.message : String(error)
    }\n\n` +
      `Do NOT re-run. Check Acumatica Access History and the failed-attempt\n` +
      `counter for this user, then report what they show.`,
  );
  process.exitCode = 1;
});
