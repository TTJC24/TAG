import { AuthCircuitBreaker, RunLock } from "./auth-guard.js";

/**
 * One place that decides how hard the ERP authentication guard bites, so every
 * entry point behaves identically. Four commands can log in — preflight, the
 * customer export, the probe, and the scheduled feed runner — and a guard that
 * only some of them honour is not a guard.
 *
 * The default is ENFORCED. An unlabelled environment is treated as production,
 * because the failure mode of guessing wrong in the other direction is a locked
 * production account, and that has already happened twice.
 */

export type AcumaticaEnvironmentKind = "production" | "sandbox";

export interface AcumaticaGuard {
  environment: AcumaticaEnvironmentKind;
  /** Whether a tripped breaker actually blocks. False only in a sandbox. */
  enforced: boolean;
  breaker: AuthCircuitBreaker;
  lock: RunLock;
  /** State/lock file locations, for the operator to inspect or clear. */
  statePath: string;
  lockPath: string;
}

const DEFAULT_DIR = "/var/lib/operating-layer/acumatica";

/**
 * Read the environment kind. Anything other than an explicit "sandbox" is
 * production: this must fail safe, and a typo in the variable name must not
 * silently disable the guard.
 */
export function resolveAcumaticaEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AcumaticaEnvironmentKind {
  return env.ACUMATICA_ENVIRONMENT?.trim().toLowerCase() === "sandbox"
    ? "sandbox"
    : "production";
}

export function resolveAcumaticaGuard(
  env: NodeJS.ProcessEnv = process.env,
): AcumaticaGuard {
  const environment = resolveAcumaticaEnvironment(env);
  const dir = env.ACUMATICA_GUARD_DIR ?? DEFAULT_DIR;
  // Separate state per environment. A sandbox trip must never block production,
  // and — more importantly — clearing a sandbox breaker must never be mistaken
  // for clearing the production one.
  const statePath = `${dir}/${environment}-breaker.json`;
  const lockPath = `${dir}/${environment}-run.lock`;
  return {
    environment,
    enforced: environment === "production",
    breaker: new AuthCircuitBreaker(statePath, environment === "production"),
    lock: new RunLock(lockPath),
    statePath,
    lockPath,
  };
}

/**
 * Run `body` holding the exclusive authentication lock, releasing it however
 * the body ends. Two processes authenticating at once is a way to double the
 * damage before either notices.
 */
export async function withAcumaticaRunLock<T>(
  guard: AcumaticaGuard,
  label: string,
  body: () => Promise<T>,
): Promise<T> {
  guard.lock.acquire(label);
  try {
    return await body();
  } finally {
    guard.lock.release();
  }
}
