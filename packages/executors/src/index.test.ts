import { describe, expect, it } from "vitest";
import {
  DeterministicInternalExecutionProvider,
  DisabledExternalExecutionProvider,
  resolveExecutionProvider,
} from "./index.js";

const action = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  taskId: "10000000-0000-4000-8000-000000000002",
  workflowId: "10000000-0000-4000-8000-000000000003",
  approvalId: "10000000-0000-4000-8000-000000000004",
  recommendationId: "10000000-0000-4000-8000-000000000005",
  actionType: "collections_follow_up",
  summary: "Record an internal collections follow-up outcome.",
  payloadHash: "a".repeat(64),
};
const context = {
  traceId: "trace-executor-test",
  requestId: "request-executor-test",
  commandId: "command-executor-test",
  idempotencyKey: "idempotency-executor-test",
};

describe("execution provider seam", () => {
  it("enables only the deterministic internal provider by default", async () => {
    const provider = resolveExecutionProvider();
    expect(provider).toBeInstanceOf(DeterministicInternalExecutionProvider);
    expect(provider).toMatchObject({
      id: "deterministic-internal-v1",
      kind: "internal",
      enabled: true,
    });
    await expect(provider.execute(action, context)).resolves.toMatchObject({
      outcome: "succeeded",
      output: { externalEffect: false },
    });
  });

  it("keeps the external provider inert and unreachable through resolution", async () => {
    const external = new DisabledExternalExecutionProvider();
    expect(external.enabled).toBe(false);
    await expect(external.execute(action, context)).rejects.toThrow(
      /disabled/i,
    );
    expect(() => resolveExecutionProvider("external")).toThrow(/not enabled/i);
  });
});
