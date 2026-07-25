import type {
  OutputSchema,
  RiskLevel,
  SourceCitation,
} from "@operating-layer/schemas";

export type AgentKind =
  | "retrieval"
  | "classification"
  | "recommendation"
  | "drafting"
  | "verification";

export interface ModelRoute {
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
}

export interface AgentContext {
  traceId: string;
  organizationId: string;
  actorId: string;
  promptVersionId: string;
  modelRoute: ModelRoute;
  sourceCitations: readonly SourceCitation[];
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface AgentResult<TOutput> {
  output: TOutput;
  citations: readonly SourceCitation[];
  confidence: number;
  riskLevel: RiskLevel;
  decisionSummary: string;
  provider: string;
  model: string;
  usage: AgentUsage;
}

export interface Agent<TInput, TOutput> {
  readonly kind: AgentKind;
  readonly outputSchema: OutputSchema<TOutput>;
  run(context: AgentContext, input: TInput): Promise<AgentResult<TOutput>>;
}

export interface StructuredGenerationRequest<TOutput> {
  traceId: string;
  systemInstructions: string;
  input: unknown;
  outputSchema: OutputSchema<TOutput>;
  route: ModelRoute;
}

export interface ModelProvider {
  readonly name: string;
  generateStructured<TOutput>(
    request: StructuredGenerationRequest<TOutput>,
  ): Promise<{ output: unknown; usage: AgentUsage; model: string }>;
}

export function parseUntrustedModelOutput<TOutput>(
  schema: OutputSchema<TOutput>,
  output: unknown,
): TOutput {
  return schema.parse(output);
}

export class DisabledModelProvider implements ModelProvider {
  readonly name = "disabled";

  async generateStructured<TOutput>(
    _request: StructuredGenerationRequest<TOutput>,
  ): Promise<{ output: unknown; usage: AgentUsage; model: string }> {
    throw new Error(
      "Live model generation is disabled. Configure an approved provider adapter explicitly.",
    );
  }
}
