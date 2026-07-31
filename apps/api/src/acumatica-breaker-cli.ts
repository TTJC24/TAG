import { resolveAcumaticaGuard } from "@operating-layer/connectors";

/**
 * Operator command: inspect, and deliberately clear, the ERP authentication
 * circuit breaker.
 *
 *   node apps/api/dist/acumatica-breaker-cli.js status
 *   node apps/api/dist/acumatica-breaker-cli.js clear --who "Tim Clark" --confirm I-CHECKED-THE-ERP-ACCOUNT
 *
 * This is the ONLY way a blocked production login is re-enabled. Nothing in the
 * runtime clears the breaker — not a restart, not a redeploy, not a later
 * success, not a scheduled retry. That is the point: the breaker exists because
 * a production ERP service account was locked out twice, and an automatic reset
 * is exactly how a third one happens.
 *
 * The confirmation phrase is not ceremony. Clearing the breaker without first
 * checking the ERP account's own lockout state just spends the next login
 * attempt on an account that is still locked, which is the failure it is meant
 * to prevent.
 *
 * Writes nothing to the ERP and never authenticates. It only reads and writes
 * a local state file.
 */

const CONFIRM_PHRASE = "I-CHECKED-THE-ERP-ACCOUNT";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const command = process.argv[2] ?? "status";
  const guard = resolveAcumaticaGuard();
  const state = guard.breaker.read();

  console.log(`environment : ${guard.environment}`);
  console.log(
    `enforced    : ${guard.enforced}${
      guard.enforced ? "" : "  (sandbox — a trip is recorded but does not block)"
    }`,
  );
  console.log(`state file  : ${guard.statePath}`);
  console.log(`lock file   : ${guard.lockPath}`);
  console.log("");
  console.log(`tripped     : ${state.tripped}`);
  console.log(`kind        : ${state.kind ?? "—"}`);
  // Label this by what it actually is. While tripped it is the trip reason;
  // while clear it holds the clearance provenance, and printing that under
  // "reason" reads as though the breaker tripped because somebody cleared it.
  console.log(
    `${state.tripped ? "trip reason " : "last note   "}: ${state.reason || "—"}`,
  );
  console.log(`tripped at  : ${state.trippedAt ?? "—"}`);
  console.log(`consecutive : ${state.consecutiveFailures}`);
  console.log(`last success: ${state.lastSuccessAt ?? "—"}`);
  console.log(`last failure: ${state.lastFailureAt ?? "—"}`);
  // Shown even when not tripped: a run of 403s or 429s is worth seeing before
  // it becomes the reason somebody is clearing a breaker at 6am.
  console.log(`  kind      : ${state.lastFailureKind ?? "—"}`);
  console.log(`  detail    : ${state.lastFailureReason || "—"}`);

  if (command === "status") {
    // Exit 1 while blocked, so a health check or a deploy gate can see it.
    if (state.tripped && guard.enforced) process.exitCode = 1;
    return;
  }

  if (command !== "clear") {
    console.error(`\nunknown command "${command}" — expected status or clear`);
    process.exitCode = 2;
    return;
  }

  const who = arg("--who");
  const confirm = arg("--confirm");
  if (!who) {
    console.error("\n--who is required: clearing this is an attributable act");
    process.exitCode = 2;
    return;
  }
  if (confirm !== CONFIRM_PHRASE) {
    console.error(
      `\nRefusing to clear. Before re-enabling logins, confirm in Acumatica that the` +
        `\nservice account is not itself locked out (Users screen), then re-run with:` +
        `\n  --confirm ${CONFIRM_PHRASE}`,
    );
    process.exitCode = 2;
    return;
  }

  const cleared = guard.breaker.clearByOperator(who);
  console.log(`\ncleared by ${who}. Authentication is permitted again.`);
  console.log(`state: ${JSON.stringify(cleared)}`);
}

main();
