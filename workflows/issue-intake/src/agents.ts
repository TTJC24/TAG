import type {
  Agent,
  AgentContext,
  AgentResult,
  AgentUsage,
  ModelProvider,
  StructuredGenerationRequest,
} from "@operating-layer/agents";
import { parseUntrustedModelOutput } from "@operating-layer/agents";
import {
  classificationOutputSchema,
  recommendationOutputSchema,
  type ClassificationOutput,
  type RecommendationOutput,
  type SourceCitation,
} from "@operating-layer/schemas";

export interface ClassificationAgentInput {
  entityCode: "BLCS" | "FSI" | "USA" | "CULTIVUS";
  title: string;
  description: string;
  financialExposure?: number;
  createdByUserId: string;
  citation: SourceCitation;
}

export interface RecommendationAgentInput {
  title: string;
  description: string;
  taskType: string;
  priority: "P0" | "P1" | "P2" | "P3";
  financialExposure?: number;
  citation: SourceCitation;
}

function usage(latencyMs = 1): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs,
  };
}

function classifyTaskType(text: string): string {
  if (/receivable|invoice|collection|past due/i.test(text)) {
    return "collections";
  }
  if (/purchase|procurement|vendor|open quantity/i.test(text)) {
    return "procurement_follow_up";
  }
  if (/sales order|shipment|stagn|hold|inventory/i.test(text)) {
    return "order_stagnation";
  }
  if (/crm|deal|pipeline|follow[- ]?up/i.test(text)) {
    return "crm_follow_up";
  }
  if (/media|episode|video|production|review notes/i.test(text)) {
    return "media_production";
  }
  return "operational_issue";
}

function classifyPriority(
  text: string,
  financialExposure: number | undefined,
): "P0" | "P1" | "P2" | "P3" {
  if (/legal|payroll|banking|shutdown|outage|regulatory/i.test(text)) {
    return "P0";
  }
  if (
    (financialExposure ?? 0) >= 50_000 ||
    /blocked|critical|escalat|major delay/i.test(text)
  ) {
    return "P1";
  }
  return "P2";
}

export class DeterministicModelProvider implements ModelProvider {
  readonly name = "deterministic";

  async generateStructured<TOutput>(
    request: StructuredGenerationRequest<TOutput>,
  ): Promise<{ output: unknown; usage: AgentUsage; model: string }> {
    const input = request.input as
      | ({ agentKind: "classification" } & ClassificationAgentInput)
      | ({ agentKind: "recommendation" } & RecommendationAgentInput);

    if (input.agentKind === "classification") {
      const text = `${input.title}\n${input.description}`;
      const taskType = classifyTaskType(text);
      const priority = classifyPriority(text, input.financialExposure);
      return {
        output: {
          entityCode: input.entityCode,
          taskType,
          priority,
          suggestedOwnerUserId: input.createdByUserId,
          confidence: taskType === "operational_issue" ? 0.82 : 0.95,
          needsHumanReview: taskType === "operational_issue",
          decisionSummary:
            taskType === "operational_issue"
              ? "The issue is operational but lacks a more specific supported category."
              : `The submitted facts match the ${taskType} rule set.`,
          citations: [input.citation],
        },
        usage: usage(),
        model: "deterministic-rules-v1",
      };
    }

    const text = `${input.title}\n${input.description}`;
    const externalAction =
      (input.financialExposure ?? 0) >= 50_000 ||
      /email|send|customer|vendor|escalat|contact/i.test(text);
    const riskLevel = externalAction ? 4 : 2;
    return {
      output: {
        recommendationType: externalAction
          ? "draft_external_follow_up"
          : "create_internal_follow_up",
        summary: externalAction
          ? "Prepare a fact-checked follow-up draft for human approval; do not send it automatically."
          : "Create an internal follow-up with a named owner and next review date.",
        decisionSummary: externalAction
          ? "The issue indicates external coordination or material exposure, so human approval is required."
          : "The supported next step affects only internal operating-layer work.",
        confidence: 0.94,
        riskLevel,
        requiresApproval: externalAction,
        citations: [input.citation],
      },
      usage: usage(),
      model: "deterministic-rules-v1",
    };
  }
}

export class ClassificationAgent implements Agent<
  ClassificationAgentInput,
  ClassificationOutput
> {
  readonly kind = "classification" as const;
  readonly outputSchema = classificationOutputSchema;

  constructor(private readonly provider: ModelProvider) {}

  async run(
    context: AgentContext,
    input: ClassificationAgentInput,
  ): Promise<AgentResult<ClassificationOutput>> {
    const generated = await this.provider.generateStructured({
      traceId: context.traceId,
      systemInstructions:
        "Return structured classification only. Do not provide chain-of-thought.",
      input: { agentKind: "classification", ...input },
      outputSchema: this.outputSchema,
      route: context.modelRoute,
    });
    const output = parseUntrustedModelOutput(
      this.outputSchema,
      generated.output,
    );
    return {
      output,
      citations: output.citations,
      confidence: output.confidence,
      riskLevel: 0,
      decisionSummary: output.decisionSummary,
      provider: this.provider.name,
      model: generated.model,
      usage: generated.usage,
    };
  }
}

export class RecommendationAgent implements Agent<
  RecommendationAgentInput,
  RecommendationOutput
> {
  readonly kind = "recommendation" as const;
  readonly outputSchema = recommendationOutputSchema;

  constructor(private readonly provider: ModelProvider) {}

  async run(
    context: AgentContext,
    input: RecommendationAgentInput,
  ): Promise<AgentResult<RecommendationOutput>> {
    const generated = await this.provider.generateStructured({
      traceId: context.traceId,
      systemInstructions:
        "Return a cited structured recommendation only. Do not provide chain-of-thought.",
      input: { agentKind: "recommendation", ...input },
      outputSchema: this.outputSchema,
      route: context.modelRoute,
    });
    const output = parseUntrustedModelOutput(
      this.outputSchema,
      generated.output,
    );
    return {
      output,
      citations: output.citations,
      confidence: output.confidence,
      riskLevel: output.riskLevel,
      decisionSummary: output.decisionSummary,
      provider: this.provider.name,
      model: generated.model,
      usage: generated.usage,
    };
  }
}
