import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAcumaticaEnvironment,
  resolveAcumaticaGuard,
  withAcumaticaRunLock,
} from "./acumatica-guard.js";
import { ConcurrentRunError } from "./auth-guard.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acumatica-guard-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ACUMATICA_GUARD_DIR: dir,
  ...extra,
});

describe("resolveAcumaticaEnvironment", () => {
  it("treats an unset environment as production", () => {
    // Fail safe. Guessing "sandbox" here would silently disable the guard on a
    // host that simply forgot the variable — which is the production host.
    expect(resolveAcumaticaEnvironment({})).toBe("production");
  });

  it("only accepts an explicit sandbox marker", () => {
    expect(resolveAcumaticaEnvironment({ ACUMATICA_ENVIRONMENT: "sandbox" })).toBe(
      "sandbox",
    );
    expect(
      resolveAcumaticaEnvironment({ ACUMATICA_ENVIRONMENT: "  SANDBOX " }),
    ).toBe("sandbox");
  });

  it("treats a typo or any other value as production", () => {
    for (const value of ["sandbx", "test", "staging", "dev", "", "prod"]) {
      expect(
        resolveAcumaticaEnvironment({ ACUMATICA_ENVIRONMENT: value }),
      ).toBe("production");
    }
  });
});

describe("resolveAcumaticaGuard", () => {
  it("enforces in production", () => {
    const guard = resolveAcumaticaGuard(env());
    expect(guard.environment).toBe("production");
    expect(guard.enforced).toBe(true);
    guard.breaker.recordFailure("unauthorized", "rejected");
    expect(() => guard.breaker.assertMayAuthenticate()).toThrow();
  });

  it("records but does not enforce in a sandbox", () => {
    const guard = resolveAcumaticaGuard(env({ ACUMATICA_ENVIRONMENT: "sandbox" }));
    expect(guard.enforced).toBe(false);
    guard.breaker.recordFailure("unauthorized", "rejected");
    // The whole point of a sandbox: the lifecycle can be exercised repeatedly.
    expect(() => guard.breaker.assertMayAuthenticate()).not.toThrow();
    expect(guard.breaker.read().tripped).toBe(true);
  });

  it("keeps sandbox and production state entirely separate", () => {
    const sandbox = resolveAcumaticaGuard(
      env({ ACUMATICA_ENVIRONMENT: "sandbox" }),
    );
    const production = resolveAcumaticaGuard(env());
    expect(sandbox.statePath).not.toBe(production.statePath);
    expect(sandbox.lockPath).not.toBe(production.lockPath);

    // Tripping the sandbox must not block production...
    sandbox.breaker.recordFailure("unauthorized", "expected in a sandbox");
    expect(production.breaker.read().tripped).toBe(false);

    // ...and clearing the sandbox must not clear production, which is the
    // mistake that would quietly undo the guard.
    production.breaker.recordFailure("unauthorized", "the real one");
    sandbox.breaker.clearByOperator("tim");
    expect(production.breaker.read().tripped).toBe(true);
  });
});

describe("withAcumaticaRunLock", () => {
  it("releases the lock when the body succeeds", async () => {
    const guard = resolveAcumaticaGuard(env());
    await withAcumaticaRunLock(guard, "first", async () => "ok");
    await expect(
      withAcumaticaRunLock(guard, "second", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("releases the lock when the body throws", async () => {
    const guard = resolveAcumaticaGuard(env());
    await expect(
      withAcumaticaRunLock(guard, "failing", async () => {
        throw new Error("read blew up");
      }),
    ).rejects.toThrow("read blew up");
    // A crashed run must not wedge every future run behind a lock nobody holds.
    await expect(
      withAcumaticaRunLock(guard, "next", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("refuses a run while another holds the lock", async () => {
    const guard = resolveAcumaticaGuard(env());
    const other = resolveAcumaticaGuard(env());
    await withAcumaticaRunLock(guard, "holder", async () => {
      await expect(
        withAcumaticaRunLock(other, "intruder", async () => "ok"),
      ).rejects.toThrow(ConcurrentRunError);
    });
  });

  it("does not let a sandbox run block a production run", async () => {
    const sandbox = resolveAcumaticaGuard(
      env({ ACUMATICA_ENVIRONMENT: "sandbox" }),
    );
    const production = resolveAcumaticaGuard(env());
    await withAcumaticaRunLock(sandbox, "sandbox-run", async () => {
      await expect(
        withAcumaticaRunLock(production, "production-run", async () => "ok"),
      ).resolves.toBe("ok");
    });
  });
});
