export interface ExecutionAction {
  organizationId: string;
  taskId: string;
  workflowId: string;
  approvalId: string;
  recommendationId: string;
  actionType: string;
  summary: string;
  payloadHash: string;
}

export interface ExecutionContext {
  traceId: string;
  requestId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface ExecutionProvider {
  readonly id: string;
  readonly kind: "internal" | "external";
  readonly enabled: boolean;
  execute(action: ExecutionAction, context: ExecutionContext): Promise<unknown>;
}

export interface ExternalExecutionProvider extends ExecutionProvider {
  readonly kind: "external";
  readonly enabled: false;
}

export interface DeterministicExecutionProviderOptions {
  outcome?: "succeeded" | "failed";
  failureCode?: string;
}

export class DeterministicInternalExecutionProvider implements ExecutionProvider {
  readonly id = "deterministic-internal-v1";
  readonly kind = "internal" as const;
  readonly enabled = true;

  constructor(
    private readonly options: DeterministicExecutionProviderOptions = {},
  ) {}

  async execute(
    action: ExecutionAction,
    context: ExecutionContext,
  ): Promise<unknown> {
    if (this.options.outcome === "failed") {
      return {
        outcome: "failed",
        summary: `Deterministic internal execution failed for ${action.actionType}.`,
        output: {
          actionType: action.actionType,
          commandId: context.commandId,
          failureCode:
            this.options.failureCode ?? "deterministic_execution_failure",
        },
      };
    }

    return {
      outcome: "succeeded",
      summary: `Recorded internal outcome for ${action.actionType}.`,
      output: {
        actionType: action.actionType,
        commandId: context.commandId,
        taskId: action.taskId,
        recommendationId: action.recommendationId,
        externalEffect: false,
      },
    };
  }
}

export class DisabledExternalExecutionProvider implements ExternalExecutionProvider {
  readonly id = "external-disabled";
  readonly kind = "external" as const;
  readonly enabled = false as const;

  async execute(
    _action: ExecutionAction,
    _context: ExecutionContext,
  ): Promise<never> {
    throw new Error("External execution providers are disabled");
  }
}

export function resolveExecutionProvider(
  configuredProvider = "deterministic_internal",
): ExecutionProvider {
  if (configuredProvider === "deterministic_internal") {
    return new DeterministicInternalExecutionProvider();
  }
  throw new Error(
    `Execution provider ${configuredProvider} is not enabled; only deterministic_internal is available`,
  );
}
