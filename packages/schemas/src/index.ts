import { z } from "zod";

export const organizationCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_+-]+$/);

export const entityCodeSchema = z.enum(["BLCS", "FS", "USA", "CULTIVUS"]);
export type EntityCode = z.infer<typeof entityCodeSchema>;

export const taskStatusSchema = z.enum([
  "received",
  "normalized",
  "classified",
  "recommended",
  "blocked",
  "awaiting_approval",
  "approved",
  "executing",
  "action_queued",
  "completed",
  "execution_failed",
  "rejected",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof prioritySchema>;

export const riskLevelSchema = z.number().int().min(0).max(6);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const sourceCitationSchema = z.object({
  sourceRecordId: z.string().uuid(),
  sourceRecordVersionId: z.string().uuid(),
  locator: z.string().min(1).max(500),
  excerptHash: z.string().min(32).max(128),
  observedAt: z.string().datetime(),
});
export type SourceCitation = z.infer<typeof sourceCitationSchema>;

export const manualIssueInputSchema = z
  .object({
    organizationId: z.string().uuid(),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(3).max(10_000),
    taskType: z.string().trim().min(1).max(100).optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    financialExposure: z.number().nonnegative().max(999_999_999_999).optional(),
    financialExposureCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    retentionClassification: z
      .enum(["transient", "operational", "financial_support", "legal_hold"])
      .default("operational"),
  })
  .superRefine((value, context) => {
    const hasExposure = value.financialExposure !== undefined;
    const hasCurrency = value.financialExposureCurrency !== undefined;
    if (hasExposure !== hasCurrency) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "financialExposure and financialExposureCurrency must be provided together",
      });
    }
  });
export type ManualIssueInput = z.infer<typeof manualIssueInputSchema>;

const optionalCsvText = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).max(maximum).optional(),
  );

export const csvIssueRowSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(3).max(10_000),
    taskType: optionalCsvText(100),
    dueDate: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    ),
    financialExposure: z.preprocess((value) => {
      if (typeof value !== "string") {
        return value;
      }
      const normalized = value.trim();
      return normalized === "" ? undefined : Number(normalized);
    }, z.number().finite().nonnegative().max(999_999_999_999).optional()),
    financialExposureCurrency: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === ""
          ? undefined
          : typeof value === "string"
            ? value.trim().toUpperCase()
            : value,
      z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const hasExposure = value.financialExposure !== undefined;
    const hasCurrency = value.financialExposureCurrency !== undefined;
    if (hasExposure !== hasCurrency) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "financial_exposure and financial_exposure_currency must be provided together",
      });
    }
  });
export type CsvIssueRow = z.infer<typeof csvIssueRowSchema>;

export const csvBatchUploadInputSchema = z.object({
  organizationId: z.string().uuid(),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/\.csv$/i, "fileName must end in .csv"),
  content: z.string().min(1).max(1_000_000),
  sourceTimestamp: z.string().datetime(),
  schemaVersion: z.literal("csv-issue.v1"),
  retentionClassification: z.enum([
    "transient",
    "operational",
    "financial_support",
    "legal_hold",
  ]),
});
export type CsvBatchUploadInput = z.infer<typeof csvBatchUploadInputSchema>;

export const csvBatchRowStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "failed",
]);

export const csvBatchResultSchema = z.object({
  batchId: z.string().uuid(),
  organizationId: z.string().uuid(),
  fileName: z.string(),
  checksum: z.string().length(64),
  sourceTimestamp: z.string().datetime(),
  ingestedAt: z.string().datetime(),
  schemaVersion: z.literal("csv-issue.v1"),
  retentionClassification: z.string(),
  sourceRecordId: z.string().uuid(),
  sourceRecordVersionId: z.string().uuid(),
  duplicate: z.boolean(),
  traceId: z.string(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  rows: z.array(
    z.object({
      rowId: z.string().uuid(),
      rowNumber: z.number().int().min(2),
      status: csvBatchRowStatusSchema,
      rejectionReasons: z.array(z.string()),
      taskId: z.string().uuid().nullable(),
      workflowId: z.string().uuid().nullable(),
      safeErrorMessage: z.string().nullable(),
      attempts: z.number().int().nonnegative(),
    }),
  ),
});
export type CsvBatchResult = z.infer<typeof csvBatchResultSchema>;

export const classificationOutputSchema = z.object({
  entityCode: entityCodeSchema.nullable(),
  taskType: z.string().trim().min(1).max(100),
  priority: prioritySchema,
  suggestedOwnerUserId: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  needsHumanReview: z.boolean(),
  decisionSummary: z.string().trim().min(1).max(1000),
  citations: z.array(sourceCitationSchema).min(1),
});
export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;

export const recommendationOutputSchema = z.object({
  recommendationType: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(4000),
  decisionSummary: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  riskLevel: riskLevelSchema,
  requiresApproval: z.boolean(),
  citations: z.array(sourceCitationSchema).min(1),
});
export type RecommendationOutput = z.infer<typeof recommendationOutputSchema>;

export const issueIntakeResponseSchema = z.object({
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  workflowState: z.string(),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type IssueIntakeResponse = z.infer<typeof issueIntakeResponseSchema>;

export const approvalResolutionInputSchema = z.object({
  organizationId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(3).max(2000),
});
export type ApprovalResolutionInput = z.infer<
  typeof approvalResolutionInputSchema
>;

export const approvalResolutionResponseSchema = z.object({
  approvalId: z.string().uuid(),
  resolutionId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  workflowState: z.enum(["approved", "rejected"]),
  policyVersionId: z.string().uuid(),
  policyContentHash: z.string().length(64),
  resolvedByUserId: z.string().uuid(),
  reason: z.string(),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type ApprovalResolutionResponse = z.infer<
  typeof approvalResolutionResponseSchema
>;

export const executionTriggerInputSchema = z.object({
  organizationId: z.string().uuid(),
});
export type ExecutionTriggerInput = z.infer<typeof executionTriggerInputSchema>;

export const executionTriggerResponseSchema = z.object({
  executionCommandId: z.string().uuid(),
  outboxEventId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  approvalId: z.string().uuid(),
  recommendationId: z.string().uuid(),
  actionType: z.string().min(1),
  status: z.literal("queued"),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type ExecutionTriggerResponse = z.infer<
  typeof executionTriggerResponseSchema
>;

export const executionReplayInputSchema = z.object({
  organizationId: z.string().uuid(),
});
export type ExecutionReplayInput = z.infer<typeof executionReplayInputSchema>;

export const executionReplayResponseSchema = z.object({
  executionReplayId: z.string().uuid(),
  executionCommandId: z.string().uuid(),
  originalExecutionCommandId: z.string().uuid(),
  deadLetterEventId: z.string().uuid(),
  outboxEventId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  approvalId: z.string().uuid(),
  recommendationId: z.string().uuid(),
  actionType: z.string().min(1),
  status: z.literal("queued"),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type ExecutionReplayResponse = z.infer<
  typeof executionReplayResponseSchema
>;

export const executionProviderOutputSchema = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  summary: z.string().trim().min(1).max(4000),
  output: z.record(z.unknown()),
});
export type ExecutionProviderOutput = z.infer<
  typeof executionProviderOutputSchema
>;

const gmailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320)
  .refine((value) => !/[\r\n]/.test(value), "email cannot contain newlines");

export const gmailDraftConnectorConfigInputSchema = z
  .object({
    organizationId: z.string().uuid(),
    enabled: z.boolean(),
    allowedRecipientAddresses: z.array(gmailAddressSchema).max(500),
    allowedRecipientDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
          ),
      )
      .max(100),
    reason: z.string().trim().min(3).max(1000),
  })
  .superRefine((value, context) => {
    if (
      value.enabled &&
      value.allowedRecipientAddresses.length +
        value.allowedRecipientDomains.length ===
        0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "enabled Gmail draft configuration requires a recipient allowlist",
      });
    }
  });
export type GmailDraftConnectorConfigInput = z.infer<
  typeof gmailDraftConnectorConfigInputSchema
>;

export const gmailDraftConnectorConfigResponseSchema = z.object({
  configVersionId: z.string().uuid(),
  organizationId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  bindingVersion: z.number().int().positive(),
  enabled: z.boolean(),
  allowedRecipientAddresses: z.array(gmailAddressSchema),
  allowedRecipientDomains: z.array(z.string()),
  oauthScopes: z.tuple([
    z.literal("https://www.googleapis.com/auth/gmail.compose"),
  ]),
  reason: z.string(),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailDraftConnectorConfigResponse = z.infer<
  typeof gmailDraftConnectorConfigResponseSchema
>;

export const gmailCredentialInputSchema = z.object({
  organizationId: z.string().uuid(),
  accessToken: z.string().min(16).max(20_000),
  grantedScopes: z.array(z.string()).min(1).max(20),
  reason: z.string().trim().min(3).max(1000),
});
export type GmailCredentialInput = z.infer<typeof gmailCredentialInputSchema>;

export const gmailCredentialResponseSchema = z.object({
  credentialVersionId: z.string().uuid(),
  organizationId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  replacedCredentialVersionId: z.string().uuid().nullable(),
  revocationOutboxEventId: z.string().uuid().nullable(),
  grantedScopes: z.tuple([
    z.literal("https://www.googleapis.com/auth/gmail.compose"),
  ]),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailCredentialResponse = z.infer<
  typeof gmailCredentialResponseSchema
>;

export const gmailCredentialRevokeInputSchema = z.object({
  organizationId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
});
export type GmailCredentialRevokeInput = z.infer<
  typeof gmailCredentialRevokeInputSchema
>;

export const gmailCredentialRevokeResponseSchema = z.object({
  organizationId: z.string().uuid(),
  invalidatedCredentialVersionId: z.string().uuid().nullable(),
  revocationOutboxEventId: z.string().uuid().nullable(),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailCredentialRevokeResponse = z.infer<
  typeof gmailCredentialRevokeResponseSchema
>;

export const gmailGlobalKillInputSchema = z.object({
  killed: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
});

export const gmailDraftPilotClaimInputSchema = z.object({
  organizationId: z.string().uuid(),
  action: z.enum(["claim", "release"]),
  reason: z.string().trim().min(3).max(1000),
});
export type GmailDraftPilotClaimInput = z.infer<
  typeof gmailDraftPilotClaimInputSchema
>;

export const gmailDraftPilotClaimResponseSchema = z.object({
  organizationId: z.string().uuid(),
  organizationCode: z.string().trim().min(1).max(50),
  action: z.enum(["claimed", "released"]),
  claimVersion: z.number().int().positive(),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailDraftPilotClaimResponse = z.infer<
  typeof gmailDraftPilotClaimResponseSchema
>;

export const gmailDraftPilotPreflightInputSchema = z.object({
  organizationId: z.string().uuid(),
  expectedOrganizationCode: z.string().trim().min(1).max(50),
  expectedRecipient: gmailAddressSchema.optional(),
  expectedCredentialFingerprint: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type GmailDraftPilotPreflightInput = z.infer<
  typeof gmailDraftPilotPreflightInputSchema
>;

export const gmailDraftPilotPreflightResponseSchema = z.object({
  organizationId: z.string().uuid(),
  organizationCode: z.string().trim().min(1).max(50),
  organizationName: z.string().trim().min(1),
  pilotClaimActive: z.boolean(),
  pilotClaimedForTarget: z.boolean(),
  targetConnectorEnabled: z.boolean(),
  activeCredentialPresent: z.boolean(),
  credentialEnvelopeValid: z.boolean(),
  credentialFingerprintMatches: z.boolean().nullable(),
  exactComposeScope: z.boolean(),
  exactSingleRecipientAllowlist: z.boolean(),
  expectedRecipientAllowed: z.boolean().nullable(),
  otherEnabledOrganizationCount: z.number().int().nonnegative(),
  allOtherOrganizationsDisabled: z.boolean(),
  globalKillCleared: z.boolean(),
  killSwitchReachable: z.boolean(),
  structuralNoSend: z.boolean(),
  readyForLiveDraft: z.boolean(),
  disabledByDefault: z.boolean(),
  checks: z.record(z.boolean()),
  traceId: z.string().min(1),
});
export type GmailDraftPilotPreflightResponse = z.infer<
  typeof gmailDraftPilotPreflightResponseSchema
>;

export const gmailDraftPreviewInputSchema = z.object({
  organizationId: z.string().uuid(),
  to: gmailAddressSchema,
  subject: z
    .string()
    .trim()
    .min(1)
    .max(998)
    .refine(
      (value) => !/[\r\n]/.test(value),
      "subject cannot contain newlines",
    ),
  body: z.string().min(1).max(100_000),
});
export type GmailDraftPreviewInput = z.infer<
  typeof gmailDraftPreviewInputSchema
>;

export const gmailDraftPreviewResponseSchema = z.object({
  previewId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  approvalId: z.string().uuid(),
  connectorConfigVersionId: z.string().uuid(),
  policyVersionId: z.string().uuid(),
  renderedPayload: z.object({
    to: gmailAddressSchema,
    subject: z.string(),
    body: z.string(),
  }),
  renderedPayloadHash: z.string().length(64),
  workflowState: z.literal("awaiting_external_authorization"),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailDraftPreviewResponse = z.infer<
  typeof gmailDraftPreviewResponseSchema
>;

export const gmailDraftAuthorizationInputSchema = z.object({
  organizationId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
});
export type GmailDraftAuthorizationInput = z.infer<
  typeof gmailDraftAuthorizationInputSchema
>;

export const gmailDraftAuthorizationResponseSchema = z.object({
  authorizationId: z.string().uuid(),
  previewId: z.string().uuid(),
  executionCommandId: z.string().uuid(),
  outboxEventId: z.string().uuid(),
  taskId: z.string().uuid(),
  workflowId: z.string().uuid(),
  approvalId: z.string().uuid(),
  renderedPayloadHash: z.string().length(64),
  workflowState: z.literal("external_authorized"),
  duplicate: z.boolean(),
  traceId: z.string().min(1),
});
export type GmailDraftAuthorizationResponse = z.infer<
  typeof gmailDraftAuthorizationResponseSchema
>;

export const gmailDraftProviderOutputSchema = z.object({
  outcome: z.literal("succeeded"),
  summary: z.string().trim().min(1).max(4000),
  output: z.object({
    capability: z.literal("drafts.create"),
    draftId: z.string().trim().min(1).max(500),
    messageId: z.string().trim().min(1).max(500),
    threadId: z.string().trim().min(1).max(500).nullable(),
    draftLink: z.string().url(),
    renderedPayloadHash: z.string().length(64),
  }),
});
export type GmailDraftProviderOutput = z.infer<
  typeof gmailDraftProviderOutputSchema
>;

export type OutputSchema<T> = {
  parse(input: unknown): T;
};
