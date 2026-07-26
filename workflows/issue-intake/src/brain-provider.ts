import type {
  AgentUsage,
  ModelProvider,
  StructuredGenerationRequest,
} from "@operating-layer/agents";
import {
  CompanyBrainClient,
  type CompanyBrainAnswer,
  type CompanyBrainScope,
} from "@operating-layer/connectors";
import { DeterministicModelProvider } from "./agents.js";

/**
 * Brain-grounded model provider.
 *
 * company-brain is the knowledge layer; this control plane is the acting
 * layer. The division of labor is deliberate:
 *
 * - Business rules (task typing, priority, approval thresholds) stay in the
 *   deterministic base provider — never in the brain or a prompt.
 * - The brain contributes grounding only: real citations from the group's
 *   systems, folded into the decision summary as text, and a confidence grade
 *   that can lower (never raise) the final confidence. A low brain grade
 *   forces human review on classification.
 * - Brain citations are NOT converted into structured source citations: those
 *   reference this database's own immutable source records, and fabricating
 *   them would corrupt the audit trail.
 * - The brain being unreachable fails closed: the job errors into the
 *   existing bounded-retry / dead-letter machinery. No silent degradation.
 */

const DECISION_SUMMARY_LIMIT = 1000;
const QUESTION_LIMIT = 500;

const brainConfidenceCap: Record<CompanyBrainAnswer["confidence"], number> = {
  high: 1,
  medium: 0.85,
  low: 0.6,
};

export function toBrainScope(
  entityCode: string | undefined,
): CompanyBrainScope {
  switch (entityCode) {
    case "FS":
      return "fs";
    case "BLCS":
      return "blcs";
    case "USA":
      return "usa";
    default:
      // CULTIVUS and unknown scopes fall back to group-shared memory.
      return "shared";
  }
}

function groundingQuestion(title: string, description: string): string {
  return `What relevant operational context exists for: ${title} — ${description}`.slice(
    0,
    QUESTION_LIMIT,
  );
}

function groundedSummary(
  baseSummary: string,
  answer: CompanyBrainAnswer,
): string {
  const refs = answer.citations
    .slice(0, 3)
    .map((citation) => citation.title ?? citation.slug)
    .join("; ");
  const firstLine = answer.text.split("\n")[0] ?? "";
  const grounding = ` | company-brain (${answer.confidence}): ${firstLine}${
    refs ? ` Refs: ${refs}` : ""
  }`;
  return (baseSummary + grounding).slice(0, DECISION_SUMMARY_LIMIT);
}

export class CompanyBrainModelProvider implements ModelProvider {
  readonly name = "company_brain";

  constructor(
    private readonly client: CompanyBrainClient,
    private readonly base: ModelProvider = new DeterministicModelProvider(),
  ) {}

  async generateStructured<TOutput>(
    request: StructuredGenerationRequest<TOutput>,
  ): Promise<{ output: unknown; usage: AgentUsage; model: string }> {
    const started = Date.now();
    const generated = await this.base.generateStructured(request);
    const input = request.input as {
      agentKind: "classification" | "recommendation";
      entityCode?: string;
      title: string;
      description: string;
    };

    // Fails closed on unreachable/malformed answers by design.
    const answer = await this.client.ask({
      question: groundingQuestion(input.title, input.description),
      entity: toBrainScope(input.entityCode),
    });

    const output = generated.output as Record<string, unknown>;
    const baseConfidence =
      typeof output.confidence === "number" ? output.confidence : 0;
    const grounded: Record<string, unknown> = {
      ...output,
      confidence: Math.min(
        baseConfidence,
        brainConfidenceCap[answer.confidence],
      ),
      decisionSummary: groundedSummary(
        typeof output.decisionSummary === "string"
          ? output.decisionSummary
          : "",
        answer,
      ),
    };
    if (input.agentKind === "classification") {
      grounded.needsHumanReview =
        output.needsHumanReview === true || answer.confidence === "low";
    }

    return {
      output: grounded,
      usage: { ...generated.usage, latencyMs: Date.now() - started },
      model: `company-brain+${generated.model}`,
    };
  }
}

export interface ModelProviderEnv {
  MODEL_PROVIDER?: string;
  COMPANY_BRAIN_URL?: string;
  COMPANY_BRAIN_TIMEOUT_MS?: string;
}

/**
 * Deterministic remains the default; the brain-grounded provider must be
 * enabled explicitly and requires an explicit base URL. Anything else stays
 * rejected — the same posture as every other live capability.
 */
export function resolveModelProvider(
  env: ModelProviderEnv = process.env as ModelProviderEnv,
): ModelProvider {
  const configured = env.MODEL_PROVIDER ?? "deterministic";
  if (configured === "deterministic") {
    return new DeterministicModelProvider();
  }
  if (configured === "company_brain") {
    if (!env.COMPANY_BRAIN_URL) {
      throw new Error(
        "MODEL_PROVIDER=company_brain requires COMPANY_BRAIN_URL",
      );
    }
    return new CompanyBrainModelProvider(
      new CompanyBrainClient({
        baseUrl: env.COMPANY_BRAIN_URL,
        ...(env.COMPANY_BRAIN_TIMEOUT_MS
          ? { timeoutMs: Number(env.COMPANY_BRAIN_TIMEOUT_MS) }
          : {}),
      }),
    );
  }
  throw new Error(
    `Model provider ${configured} is not enabled; use deterministic or company_brain`,
  );
}
