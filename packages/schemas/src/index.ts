import { z } from "zod";

export const organizationCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_+-]+$/);

export const entityCodeSchema = z.enum(["BLCS", "FSI", "USA", "CULTIVUS"]);
export type EntityCode = z.infer<typeof entityCodeSchema>;

export const taskStatusSchema = z.enum([
  "received",
  "normalized",
  "classified",
  "recommended",
  "blocked",
  "awaiting_approval",
  "approved",
  "action_queued",
  "completed",
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
  workflowState: z.enum(["completed", "rejected"]),
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

export type OutputSchema<T> = {
  parse(input: unknown): T;
};
