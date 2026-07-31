import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthCircuitBreaker,
  AuthCircuitOpenError,
  classifyAuthFailure,
  ConcurrentRunError,
  RunLock,
} from "./auth-guard.js";

/**
 * These tests exist because the failure they guard against already happened
 * twice: a production ERP service account was locked out. The behaviour under
 * test is therefore not "nice to have" — a regression here costs an account.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auth-guard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const statePath = (): string => join(dir, "nested", "breaker.json");

describe("AuthCircuitBreaker", () => {
  it("permits authentication when no failure has been recorded", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    expect(() => breaker.assertMayAuthenticate()).not.toThrow();
    expect(breaker.read().tripped).toBe(false);
  });

  it("trips on a 401 and refuses every subsequent authentication", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    breaker.recordFailure("unauthorized", "login rejected");
    expect(() => breaker.assertMayAuthenticate()).toThrow(AuthCircuitOpenError);
  });

  it("survives process restart — a fresh instance still sees the trip", () => {
    const path = statePath();
    new AuthCircuitBreaker(path).recordFailure("locked_out", "account locked");

    // A different instance stands in for a restarted container. The in-memory
    // latch this replaced died here, which is the whole reason for the file.
    const afterRestart = new AuthCircuitBreaker(path);
    expect(afterRestart.read().tripped).toBe(true);
    expect(() => afterRestart.assertMayAuthenticate()).toThrow(
      AuthCircuitOpenError,
    );
  });

  it("does not trip on 403, 429 or transport failures", () => {
    for (const kind of ["forbidden", "rate_limited", "transport"] as const) {
      const breaker = new AuthCircuitBreaker(join(dir, `${kind}.json`));
      const state = breaker.recordFailure(kind, `${kind} happened`);
      expect(state.tripped).toBe(false);
      expect(() => breaker.assertMayAuthenticate()).not.toThrow();
      // Still recorded, and recorded with its KIND, so an operator can tell a
      // permissions gap from throttling without reading application logs.
      expect(state.lastFailureAt).not.toBeNull();
      expect(state.lastFailureKind).toBe(kind);
      expect(state.lastFailureReason).toBe(`${kind} happened`);
    }
  });

  it("keeps the original trip reason when a non-tripping failure follows", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    breaker.recordFailure("unauthorized", "the one that mattered");
    const after = breaker.recordFailure("rate_limited", "noise");
    expect(after.tripped).toBe(true);
    expect(after.kind).toBe("unauthorized");
    expect(after.reason).toBe("the one that mattered");
    // ...while the latest failure is still visible in its own right.
    expect(after.lastFailureKind).toBe("rate_limited");
    expect(after.lastFailureReason).toBe("noise");
  });

  it("counts consecutive tripping failures and preserves the first trip time", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    const first = breaker.recordFailure("unauthorized", "one");
    const second = breaker.recordFailure("server_error", "two");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.trippedAt).toBe(first.trippedAt);
  });

  it("only clears by deliberate operator action", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    breaker.recordFailure("unauthorized", "login rejected");

    const cleared = breaker.clearByOperator("tim");
    expect(cleared.tripped).toBe(false);
    expect(cleared.reason).toContain("tim");
    expect(() => breaker.assertMayAuthenticate()).not.toThrow();

    // And the clearance is durable, not just in this instance.
    expect(new AuthCircuitBreaker(statePath()).read().tripped).toBe(false);
  });

  it("does not clear itself on a later success — success is recorded, not assumed", () => {
    const breaker = new AuthCircuitBreaker(statePath());
    breaker.recordSuccess();
    const state = breaker.read();
    expect(state.tripped).toBe(false);
    expect(state.lastSuccessAt).not.toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });

  it("is inert when not enforced, so a sandbox can exercise the lifecycle", () => {
    const path = statePath();
    const sandbox = new AuthCircuitBreaker(path, false);
    sandbox.recordFailure("unauthorized", "expected in a sandbox");
    // The failure is still written down...
    expect(sandbox.read().tripped).toBe(true);
    // ...but it does not stop the next attempt.
    expect(() => sandbox.assertMayAuthenticate()).not.toThrow();
    // The same state file read under enforcement does stop it.
    expect(() => new AuthCircuitBreaker(path).assertMayAuthenticate()).toThrow(
      AuthCircuitOpenError,
    );
  });

  it("treats an unreadable state file as clean rather than crashing", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => new AuthCircuitBreaker(path).assertMayAuthenticate()).not.toThrow();
  });

  it("fails closed on a state file that is missing fields", () => {
    const path = join(dir, "partial.json");
    writeFileSync(path, JSON.stringify({ tripped: true }), "utf8");
    const state = new AuthCircuitBreaker(path).read();
    expect(state.tripped).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe("RunLock", () => {
  const lockPath = (): string => join(dir, "run", "acumatica.lock");

  it("acquires when nothing holds it", () => {
    const lock = new RunLock(lockPath());
    expect(() => lock.acquire("preflight")).not.toThrow();
    lock.release();
  });

  it("refuses a second holder while the first is live", () => {
    const path = lockPath();
    const first = new RunLock(path);
    first.acquire("preflight");
    const second = new RunLock(path);
    expect(() => second.acquire("export")).toThrow(ConcurrentRunError);
    first.release();
  });

  it("names the current holder so an operator knows what to look for", () => {
    const path = lockPath();
    new RunLock(path).acquire("feed-runner");
    expect(() => new RunLock(path).acquire("export")).toThrow(/feed-runner/);
  });

  it("allows acquisition once the previous holder released", () => {
    const path = lockPath();
    const first = new RunLock(path);
    first.acquire("preflight");
    first.release();
    expect(() => new RunLock(path).acquire("export")).not.toThrow();
  });

  it("reclaims a stale lock left behind by a killed process", () => {
    const path = lockPath();
    const holder = new RunLock(path);
    holder.acquire("killed-run");
    // A killed process leaves the file behind with its original timestamp. Age
    // it past the stale window rather than trusting a pid, which may have been
    // reused by an unrelated process.
    const aged = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ label: "killed-run", at: aged }));

    expect(() => new RunLock(path).acquire("next-run")).not.toThrow();
    const current = JSON.parse(readFileSync(path, "utf8")) as { label: string };
    expect(current.label).toBe("next-run");
  });

  it("holds a lock that is younger than the stale window", () => {
    const path = lockPath();
    new RunLock(path).acquire("running-now");
    // Same file, generous stale window: still held.
    expect(() => new RunLock(path, 60 * 60_000).acquire("second")).toThrow(
      ConcurrentRunError,
    );
  });

  it("treats an unreadable lock file as held rather than clobbering it", () => {
    const path = join(dir, "unreadable.lock");
    writeFileSync(path, "not json at all", "utf8");
    expect(() => new RunLock(path).acquire("export")).toThrow(ConcurrentRunError);
  });

  it("release is a no-op for a lock this instance never acquired", () => {
    const path = lockPath();
    const holder = new RunLock(path);
    holder.acquire("preflight");

    const stranger = new RunLock(path);
    stranger.release(); // must not remove somebody else's lock

    expect(() => new RunLock(path).acquire("export")).toThrow(ConcurrentRunError);
    holder.release();
  });
});

describe("classifyAuthFailure", () => {
  it("separates the four kinds the operator asked to be treated separately", () => {
    expect(classifyAuthFailure(401, "")).toBe("unauthorized");
    expect(classifyAuthFailure(403, "")).toBe("forbidden");
    expect(classifyAuthFailure(429, "")).toBe("rate_limited");
    expect(classifyAuthFailure(500, "")).toBe("server_error");
  });

  it("recognises an explicit lockout regardless of status code", () => {
    expect(
      classifyAuthFailure(500, "The user is locked out of the system."),
    ).toBe("locked_out");
    expect(classifyAuthFailure(401, "Account is Locked Out")).toBe("locked_out");
  });

  it("falls back to transport for a status that carries no auth meaning", () => {
    expect(classifyAuthFailure(0, "")).toBe("transport");
    expect(classifyAuthFailure(404, "")).toBe("transport");
  });
});

describe("login transport failures", () => {
  it("trips, because an unanswered login may still have reached the server", () => {
    const breaker = new AuthCircuitBreaker(join(dir, "login-transport.json"));
    const state = breaker.recordFailure("login_transport", "login timed out");
    expect(state.tripped).toBe(true);
    expect(() => breaker.assertMayAuthenticate()).toThrow(AuthCircuitOpenError);
  });

  it("is distinct from a read that got no answer, which does not trip", () => {
    const breaker = new AuthCircuitBreaker(join(dir, "read-transport.json"));
    // A read carries a session, not a credential, so it cannot count against
    // an authentication threshold.
    expect(breaker.recordFailure("transport", "read timed out").tripped).toBe(
      false,
    );
  });
});
