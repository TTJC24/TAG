import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Authentication circuit breaker and run lock for ERP credentials.
 *
 * Context, so the strictness is not mistaken for paranoia: this integration
 * locked a production ERP service account out twice. The in-memory latch that
 * followed was not sufficient — it dies with the process, so a restarted
 * container would happily authenticate again into the same failure.
 *
 * The rules encoded here:
 *
 *  - State is PERSISTENT. A tripped breaker survives restarts, redeploys and
 *    crashes, because the account lockout it protects survives them too.
 *  - Only a deliberate operator action clears it. Nothing in the runtime may
 *    reset the breaker, and nothing re-authenticates automatically.
 *  - Runs are exclusive. Two processes authenticating at once is a way to
 *    double the damage before either notices.
 *  - Failure kinds are NOT equivalent. A 403 is a permissions fact, a 429 is
 *    back-pressure, a 5xx may be a lockout. Only the kinds that plausibly
 *    count against an authentication threshold trip the breaker.
 *
 * None of this applies to a sandbox environment, which is the point: the
 * lifecycle should be exercised somewhere failure is cheap.
 */

export type AuthFailureKind =
  | "unauthorized" // 401 — session rejected
  | "forbidden" // 403 — authenticated but not permitted
  | "rate_limited" // 429 — back-pressure, not an auth problem
  | "server_error" // 5xx — may be a lockout; body usually says
  | "locked_out" // the server explicitly said the account is locked
  | "login_transport" // a LOGIN that got no answer; may still have landed
  | "transport"; // a read that got no answer; never reached the server

/** Kinds that plausibly increment a server-side authentication counter. */
const TRIPPING_KINDS: ReadonlySet<AuthFailureKind> = new Set<AuthFailureKind>([
  "unauthorized",
  "locked_out",
  "server_error",
  // A login that timed out or was aborted may still have REACHED the server and
  // counted against the lockout threshold — we simply never saw the answer.
  // Treating that as harmless is the assumption that cannot be verified from
  // this side, so it is not made: an unanswered login stops the next one.
  // A read that got no answer is different and stays non-tripping, since it
  // carries a session rather than a credential.
  "login_transport",
]);

export interface BreakerState {
  tripped: boolean;
  /** Why it tripped. Sticky — a later non-tripping failure must not erase it. */
  reason: string;
  kind: AuthFailureKind | null;
  trippedAt: string | null;
  /** Consecutive tripping failures since the last success. */
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /**
   * The most recent failure of ANY kind, tripping or not. Kept separately from
   * the trip fields so a 403 or a 429 is still visible to an operator: a
   * timestamp with no kind attached tells them something went wrong and nothing
   * about what, which is the same as telling them nothing.
   */
  lastFailureKind: AuthFailureKind | null;
  lastFailureReason: string;
}

const CLEAN: BreakerState = {
  tripped: false,
  reason: "",
  kind: null,
  trippedAt: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureKind: null,
  lastFailureReason: "",
};

export class AuthCircuitOpenError extends Error {
  readonly state: BreakerState;
  constructor(state: BreakerState) {
    super(
      `Authentication is blocked by the circuit breaker (${state.kind ?? "unknown"}): ${state.reason}. ` +
        `Tripped at ${state.trippedAt}. This will NOT clear on its own — an operator must inspect the ERP ` +
        `account and clear it deliberately.`,
    );
    this.name = "AuthCircuitOpenError";
    this.state = state;
  }
}

export class ConcurrentRunError extends Error {
  constructor(holder: string) {
    super(
      `Another run already holds the authentication lock (${holder}). ` +
        `Concurrent runs are refused so two processes cannot authenticate at once.`,
    );
    this.name = "ConcurrentRunError";
  }
}

/**
 * Persistent breaker backed by a JSON file.
 *
 * A file rather than the database on purpose: the breaker must work when the
 * process cannot reach anything, including during startup, and it must be
 * inspectable and clearable by an operator with nothing but a shell.
 */
export class AuthCircuitBreaker {
  constructor(
    private readonly statePath: string,
    /**
     * Non-production environments are not gated. The whole point is to make the
     * authentication lifecycle testable somewhere that failing is free.
     */
    private readonly enforced = true,
  ) {}

  read(): BreakerState {
    try {
      const raw = readFileSync(this.statePath, "utf8");
      return { ...CLEAN, ...(JSON.parse(raw) as Partial<BreakerState>) };
    } catch {
      return { ...CLEAN };
    }
  }

  private write(state: BreakerState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  /** Throws unless authentication is currently permitted. */
  assertMayAuthenticate(): void {
    if (!this.enforced) return;
    const state = this.read();
    if (state.tripped) throw new AuthCircuitOpenError(state);
  }

  recordSuccess(): void {
    this.write({
      ...CLEAN,
      lastSuccessAt: new Date().toISOString(),
    });
  }

  /**
   * Record a failure. Trips immediately on the first tripping failure rather
   * than after a threshold: the cost of a false stop is one operator command,
   * and the cost of a false continue is a locked-out production account.
   */
  recordFailure(kind: AuthFailureKind, reason: string): BreakerState {
    const previous = this.read();
    const trips = TRIPPING_KINDS.has(kind);
    const next: BreakerState = {
      tripped: previous.tripped || trips,
      reason: trips ? reason : previous.reason,
      kind: trips ? kind : previous.kind,
      trippedAt: previous.trippedAt ?? (trips ? new Date().toISOString() : null),
      consecutiveFailures: trips ? previous.consecutiveFailures + 1 : 0,
      lastSuccessAt: previous.lastSuccessAt,
      lastFailureAt: new Date().toISOString(),
      lastFailureKind: kind,
      lastFailureReason: reason,
    };
    this.write(next);
    return next;
  }

  /** Deliberate operator action. Nothing in the runtime may call this. */
  clearByOperator(who: string): BreakerState {
    const cleared: BreakerState = {
      ...CLEAN,
      reason: `cleared by ${who} at ${new Date().toISOString()}`,
    };
    this.write(cleared);
    return cleared;
  }
}

/**
 * Exclusive run lock. Uses O_EXCL so acquisition is atomic; a stale lock from a
 * killed process is detected by age rather than by trusting a pid.
 */
export class RunLock {
  private acquired = false;

  constructor(
    private readonly lockPath: string,
    private readonly staleAfterMs = 30 * 60_000,
  ) {}

  acquire(label: string): void {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    try {
      const fd = openSync(this.lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ label, at: new Date().toISOString() }));
      closeSync(fd);
      this.acquired = true;
      return;
    } catch {
      // already held — decide whether it is stale
    }
    let holder = "unknown";
    try {
      const raw = JSON.parse(readFileSync(this.lockPath, "utf8")) as {
        label?: string;
        at?: string;
      };
      holder = raw.label ?? "unknown";
      const age = Date.now() - new Date(raw.at ?? 0).getTime();
      if (age > this.staleAfterMs) {
        rmSync(this.lockPath, { force: true });
        this.acquire(label);
        return;
      }
    } catch {
      // unreadable lock file: treat as held rather than clobbering it
    }
    throw new ConcurrentRunError(holder);
  }

  release(): void {
    if (!this.acquired) return;
    rmSync(this.lockPath, { force: true });
    this.acquired = false;
  }
}

/** Classify an HTTP status into an auth failure kind. */
export function classifyAuthFailure(
  status: number,
  body: string,
): AuthFailureKind {
  if (/locked out/i.test(body)) return "locked_out";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "transport";
}
