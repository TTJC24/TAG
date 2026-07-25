export type WorkflowState =
  | "received"
  | "normalized"
  | "classified"
  | "recommended"
  | "awaiting_approval"
  | "approved"
  | "action_queued"
  | "completed"
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
  awaiting_approval: ["blocked", "failed", "cancelled"],
  approved: [],
  action_queued: [],
  completed: [],
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
}

export function evaluateApprovalPolicy(
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
