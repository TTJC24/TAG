import { z } from "zod";

export type WorkflowState =
  | "received"
  | "normalized"
  | "classified"
  | "recommended"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "action_queued"
  | "completed"
  | "execution_failed"
  | "rejected"
  | "blocked"
  | "failed"
  | "cancelled";

export interface WorkflowCommand<TPayload = unknown> {
  commandId: string;
  traceId: string;
  workflowId: string;
  organizationId: string;
  actorId: string;
  expectedVersion: number;
  type: string;
  payload: TPayload;
}

export interface WorkflowSnapshot<TData = unknown> {
  id: string;
  organizationId: string;
  type: string;
  state: WorkflowState;
  version: number;
  data: TData;
}

export interface WorkflowTransition<TData = unknown> {
  from: WorkflowState;
  to: WorkflowState;
  nextData: TData;
  eventType: string;
  outboxMessages: readonly {
    topic: string;
    idempotencyKey: string;
    payloadReference: string;
  }[];
}

export interface WorkflowDefinition<TData = unknown> {
  readonly type: string;
  transition(
    snapshot: WorkflowSnapshot<TData>,
    command: WorkflowCommand,
  ): WorkflowTransition<TData>;
}

export interface WorkflowEngine {
  dispatch(command: WorkflowCommand): Promise<WorkflowSnapshot>;
  load(
    organizationId: string,
    workflowId: string,
  ): Promise<WorkflowSnapshot | null>;
}

export const issueIntakeTransitions: Readonly<
  Record<WorkflowState, readonly WorkflowState[]>
> = {
  received: ["normalized", "blocked", "failed", "cancelled"],
  normalized: ["classified", "blocked", "failed", "cancelled"],
  classified: ["recommended", "blocked", "failed", "cancelled"],
  recommended: [
    "awaiting_approval",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ],
  awaiting_approval: ["approved", "rejected", "blocked", "failed", "cancelled"],
  approved: ["executing"],
  executing: ["completed", "execution_failed"],
  action_queued: [],
  completed: [],
  execution_failed: [],
  rejected: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export function isIssueIntakeTransitionAllowed(
  from: WorkflowState,
  to: WorkflowState,
): boolean {
  return issueIntakeTransitions[from].includes(to);
}

export interface ApprovalPolicyInput {
  riskLevel: number;
  requestedAction: string;
}

export interface ApprovalPolicyDecision {
  allowedInPhase: boolean;
  requiresApproval: boolean;
  reasonCode: string;
  policyVersion: string;
  policyVersionId?: string;
  policyContentHash?: string;
  effect?: ApprovalPolicyEffect;
  approverCount?: number;
  approverPermission?: string | null;
}

export function evaluatePhase1ApprovalPolicy(
  input: ApprovalPolicyInput,
): ApprovalPolicyDecision {
  if (!Number.isInteger(input.riskLevel) || input.riskLevel < 0) {
    throw new Error("Invalid risk level");
  }
  if (input.riskLevel >= 6) {
    return {
      allowedInPhase: false,
      requiresApproval: true,
      reasonCode: "risk_6_prohibited",
      policyVersion: "phase1-v1",
    };
  }
  if (input.riskLevel >= 3) {
    return {
      allowedInPhase: input.riskLevel <= 4,
      requiresApproval: true,
      reasonCode:
        input.riskLevel === 5
          ? "risk_5_write_prohibited_in_phase1"
          : "human_approval_required",
      policyVersion: "phase1-v1",
    };
  }
  return {
    allowedInPhase: true,
    requiresApproval: false,
    reasonCode: "low_risk_internal_action",
    policyVersion: "phase1-v1",
  };
}

export const evaluateApprovalPolicy = evaluatePhase1ApprovalPolicy;

export const approvalPolicyFieldSchema = z.enum([
  "task.organization_id",
  "task.task_type",
  "task.category",
  "task.financial_exposure.amount",
  "task.financial_exposure.currency",
  "task.source_type",
  "task.source_system_id",
  "recommendation.risk_level",
  "recommendation.recommendation_type",
  "requested_action.action_type",
  "requested_action.target_system",
  "requested_action.cross_entity",
]);

export type ApprovalPolicyField = z.infer<typeof approvalPolicyFieldSchema>;
export type ApprovalPolicyScalar = string | number | boolean | null;

export type ApprovalPolicyPredicate =
  | {
      field: ApprovalPolicyField;
      operator: "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte" | "in" | "exists";
      value?: ApprovalPolicyScalar | ApprovalPolicyScalar[] | undefined;
    }
  | { all: ApprovalPolicyPredicate[] }
  | { any: ApprovalPolicyPredicate[] }
  | { not: ApprovalPolicyPredicate };

const approvalPolicyScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const approvalPolicyPredicateSchema: z.ZodType<ApprovalPolicyPredicate> =
  z.lazy(() =>
    z.union([
      z.object({
        field: approvalPolicyFieldSchema,
        operator: z.enum([
          "eq",
          "not_eq",
          "gt",
          "gte",
          "lt",
          "lte",
          "in",
          "exists",
        ]),
        value: z
          .union([
            approvalPolicyScalarSchema,
            z.array(approvalPolicyScalarSchema),
          ])
          .optional(),
      }),
      z.object({ all: z.array(approvalPolicyPredicateSchema) }),
      z.object({ any: z.array(approvalPolicyPredicateSchema) }),
      z.object({ not: approvalPolicyPredicateSchema }),
    ]),
  );

export const approvalPolicyEffectSchema = z.enum([
  "auto_approve",
  "requires_approval",
  "requires_n_approvers",
  "blocked",
]);
export type ApprovalPolicyEffect = z.infer<typeof approvalPolicyEffectSchema>;

export const approvalPolicyOutcomeSchema = z
  .object({
    effect: approvalPolicyEffectSchema,
    approverCount: z.number().int().nonnegative(),
    approverPermission: z.string().min(1).nullable(),
    requesterMustBeDistinct: z.boolean(),
    approversMustBeDistinct: z.boolean(),
  })
  .superRefine((value, context) => {
    const validCount =
      (value.effect === "auto_approve" && value.approverCount === 0) ||
      (value.effect === "blocked" && value.approverCount === 0) ||
      (value.effect === "requires_approval" &&
        value.approverCount === 1 &&
        value.approverPermission !== null) ||
      (value.effect === "requires_n_approvers" &&
        value.approverCount >= 2 &&
        value.approverPermission !== null);
    if (!validCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Policy effect and approver configuration are inconsistent",
      });
    }
  });

export const approvalPolicyRuleSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().positive(),
  name: z.string().min(1),
  predicate: approvalPolicyPredicateSchema,
  outcome: approvalPolicyOutcomeSchema,
  reasonCode: z.string().min(1),
});

export const declarativeApprovalPolicyVersionSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  policyKey: z.string().min(1),
  versionNumber: z.number().int().positive(),
  schemaVersion: z.literal("approval-policy.v1"),
  humanLabel: z.string().min(1),
  contentHash: z.string().length(64),
  rules: z.array(approvalPolicyRuleSchema).min(1),
});

export type DeclarativeApprovalPolicyVersion = z.infer<
  typeof declarativeApprovalPolicyVersionSchema
>;
export type DeclarativeApprovalPolicyRule = z.infer<
  typeof approvalPolicyRuleSchema
>;

export interface DeclarativeApprovalPolicyInput {
  task: {
    organizationId: string;
    taskType: string;
    category?: string;
    financialExposure?: { amount: number; currency: string };
    sourceType?: string;
    sourceSystemId?: string;
  };
  recommendation: {
    riskLevel: number;
    recommendationType: string;
  };
  requestedAction: {
    actionType: string;
    targetSystem: string;
    crossEntity: boolean;
  };
}

function fieldValue(
  input: DeclarativeApprovalPolicyInput,
  field: ApprovalPolicyField,
): ApprovalPolicyScalar | undefined {
  const values: Record<ApprovalPolicyField, ApprovalPolicyScalar | undefined> =
    {
      "task.organization_id": input.task.organizationId,
      "task.task_type": input.task.taskType,
      "task.category": input.task.category,
      "task.financial_exposure.amount": input.task.financialExposure?.amount,
      "task.financial_exposure.currency":
        input.task.financialExposure?.currency,
      "task.source_type": input.task.sourceType,
      "task.source_system_id": input.task.sourceSystemId,
      "recommendation.risk_level": input.recommendation.riskLevel,
      "recommendation.recommendation_type":
        input.recommendation.recommendationType,
      "requested_action.action_type": input.requestedAction.actionType,
      "requested_action.target_system": input.requestedAction.targetSystem,
      "requested_action.cross_entity": input.requestedAction.crossEntity,
    };
  return values[field];
}

function compareOrdered(
  left: ApprovalPolicyScalar | undefined,
  right: ApprovalPolicyScalar | ApprovalPolicyScalar[] | undefined,
  operator: "gt" | "gte" | "lt" | "lte",
): boolean {
  if (
    (typeof left !== "number" && typeof left !== "string") ||
    (typeof right !== "number" && typeof right !== "string")
  ) {
    return false;
  }
  if (typeof left !== typeof right) {
    return false;
  }
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  return left <= right;
}

function predicateMatches(
  input: DeclarativeApprovalPolicyInput,
  predicate: ApprovalPolicyPredicate,
): boolean {
  if ("all" in predicate) {
    return predicate.all.every((entry) => predicateMatches(input, entry));
  }
  if ("any" in predicate) {
    return predicate.any.some((entry) => predicateMatches(input, entry));
  }
  if ("not" in predicate) {
    return !predicateMatches(input, predicate.not);
  }

  const actual = fieldValue(input, predicate.field);
  if (predicate.operator === "exists") {
    return actual !== undefined && actual !== null;
  }
  if (predicate.operator === "eq") return actual === predicate.value;
  if (predicate.operator === "not_eq") return actual !== predicate.value;
  if (predicate.operator === "in") {
    return (
      actual !== undefined &&
      Array.isArray(predicate.value) &&
      predicate.value.includes(actual)
    );
  }
  return compareOrdered(actual, predicate.value, predicate.operator);
}

export function evaluateDeclarativeApprovalPolicy(
  input: DeclarativeApprovalPolicyInput,
  untrustedPolicy: unknown,
): ApprovalPolicyDecision {
  if (
    !Number.isInteger(input.recommendation.riskLevel) ||
    input.recommendation.riskLevel < 0
  ) {
    throw new Error("Invalid risk level");
  }

  const policy = declarativeApprovalPolicyVersionSchema.parse(untrustedPolicy);
  if (policy.organizationId !== input.task.organizationId) {
    throw new Error("Policy organization does not match task organization");
  }

  const orderedRules = [...policy.rules].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const rule = orderedRules.find((candidate) =>
    predicateMatches(input, candidate.predicate),
  );
  if (!rule) {
    throw new Error("Approval policy has no matching rule");
  }

  const allowedInPhase = rule.outcome.effect !== "blocked";
  const requiresApproval = rule.outcome.effect !== "auto_approve";
  return {
    allowedInPhase,
    requiresApproval,
    reasonCode: rule.reasonCode,
    policyVersion: policy.humanLabel,
    policyVersionId: policy.id,
    policyContentHash: policy.contentHash,
    effect: rule.outcome.effect,
    approverCount: rule.outcome.approverCount,
    approverPermission: rule.outcome.approverPermission,
  };
}
