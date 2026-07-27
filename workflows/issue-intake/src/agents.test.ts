import { describe, expect, it } from "vitest";
import type {
  AgentUsage,
  ModelProvider,
  StructuredGenerationRequest,
} from "@operating-layer/agents";
import {
  ClassificationAgent,
  DeterministicModelProvider,
  RecommendationAgent,
} from "./agents.js";

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

describe("collections always takes the external-draft path", () => {
  /**
   * Regression guard. Collections chases previously reached
   * draft_external_follow_up only because their boilerplate happened to
   * contain "sends" and "customer". Rewording that text would have silently
   * downgraded every chase to an internal follow-up and dropped the
   * human-approval gate. The task type must decide, not the prose.
   */
  async function recommend(input: {
    title: string;
    description: string;
    taskType: string;
    financialExposure?: number;
  }) {
    const agent = new RecommendationAgent(new DeterministicModelProvider());
    const result = await agent.run(context, {
      title: input.title,
      description: input.description,
      taskType: input.taskType,
      priority: "P2",
      ...(input.financialExposure !== undefined
        ? { financialExposure: input.financialExposure }
        : {}),
      citation,
    });
    return result.output;
  }

  it("requires approval for a collections chase with no triggering words", async () => {
    const output = await recommend({
      // deliberately avoids email/send/customer/vendor/escalate/contact
      title: "Collections: Acme — $1,200.50 past due",
      description: "Ladder step 1. Balance aged 1-30. Source: Acumatica AR.",
      taskType: "collections",
      financialExposure: 1_200.5,
    });

    expect(output.recommendationType).toBe("draft_external_follow_up");
    expect(output.requiresApproval).toBe(true);
  });

  it("still routes ordinary internal work to an internal follow-up", async () => {
    const output = await recommend({
      title: "Reconcile the weekly inventory count",
      description: "Counts drifted in the warehouse; schedule a recount.",
      taskType: "operational_issue",
    });

    expect(output.recommendationType).toBe("create_internal_follow_up");
    expect(output.requiresApproval).toBe(false);
  });
});
