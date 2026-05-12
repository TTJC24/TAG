// Phase 1 smoke test for the test runner itself. Replaced/removed once
// lib/shading/compute-status.test.ts lands in Step 3.

import { describe, it, expect } from "vitest";

describe("repo sanity", () => {
  it("vitest is wired and TypeScript compiles", () => {
    expect(1 + 1).toBe(2);
  });
});
