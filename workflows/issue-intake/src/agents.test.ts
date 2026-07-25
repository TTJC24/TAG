import { describe, expect, it } from "vitest";
import type {
  AgentUsage,
  ModelProvider,
  StructuredGenerationRequest,
} from "@operating-layer/agents";
import { ClassificationAgent, DeterministicModelProvider } from "./agents.js";

const citation = {
  sourceRecordId: "60000000-0000-4000-8000-000000000001",
  sourceRecordVersionId: "60000000-0000-4000-8000-000000000002",
  locator: "manual_issue.input",
  excerptHash:
    "68d0c4b18bb0d1a32c9d91f2777b0ee5e64b91de12cd8bf7fb31b35147b87f1f",
  observedAt: "2026-07-25T12:00:00.000Z",
};

const context = {
  traceId: "trace-test",
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "20000000-0000-4000-8000-000000000003",
  promptVersionId: "50000000-0000-4000-8000-000000000001",
  modelRoute: {
    provider: "deterministic",
    model: "deterministic-rules-v1",
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxCostUsd: 0,
  },
  sourceCitations: [citation],
};

describe("schema-validated agent output", () => {
  it("accepts the deterministic classifier through the runtime schema", async () => {
    const agent = new ClassificationAgent(new DeterministicModelProvider());
    const result = await agent.run(context, {
      entityCode: "BLCS",
      title: "Past due invoice needs collections follow-up",
      description: "The invoice is overdue and the customer needs contact.",
      financialExposure: 75_000,
      createdByUserId: context.actorId,
      citation,
    });

    expect(result.output.taskType).toBe("collections");
    expect(result.output.priority).toBe("P1");
    expect(result.output.citations).toEqual([citation]);
    expect(result.decisionSummary.length).toBeGreaterThan(0);
  });

  it("rejects malformed provider output before it can be persisted", async () => {
    class MalformedProvider implements ModelProvider {
      readonly name = "malformed-test";

      async generateStructured<TOutput>(
        _request: StructuredGenerationRequest<TOutput>,
      ): Promise<{
        output: unknown;
        usage: AgentUsage;
        model: string;
      }> {
        return {
          output: {
            entityCode: "BLCS",
            taskType: "collections",
            priority: "not-a-priority",
            confidence: 4,
            citations: [],
            privateChainOfThought: "must never be stored",
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
            latencyMs: 1,
          },
          model: "malformed",
        };
      }
    }

    const agent = new ClassificationAgent(new MalformedProvider());
    await expect(
      agent.run(context, {
        entityCode: "BLCS",
        title: "Past due invoice",
        description: "Needs follow-up.",
        createdByUserId: context.actorId,
        citation,
      }),
    ).rejects.toThrow();
  });
});
