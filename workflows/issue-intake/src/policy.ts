import { randomUUID } from "node:crypto";
import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import {
  withOrganizationScope,
  type DatabaseClient,
  type DatabasePool,
} from "@operating-layer/db";
import {
  approvalPolicyRuleSchema,
  declarativeApprovalPolicyVersionSchema,
  type DeclarativeApprovalPolicyRule,
  type DeclarativeApprovalPolicyVersion,
} from "@operating-layer/workflows";
import { DomainError } from "./errors.js";
import {
  requireOrganizationPermission,
  type ApplicationPrincipal,
} from "./identity.js";
import type { RequestContext } from "./service.js";

export async function loadActiveApprovalPolicy(
  client: DatabaseClient,
  organizationId: string,
  policyKey = "issue_intake",
): Promise<DeclarativeApprovalPolicyVersion> {
  const versionResult = await client.query<{
    id: string;
    organization_id: string;
    policy_key: string;
    version_number: number;
    schema_version: "approval-policy.v1";
    human_label: string;
    content_hash: string;
  }>(
    `SELECT
       version.id,
       version.organization_id,
       version.policy_key,
       version.version_number,
       version.schema_version,
       version.human_label,
       version.content_hash
     FROM approval_policy_bindings binding
     JOIN approval_policy_versions version
       ON version.id = binding.active_policy_version_id
      AND version.organization_id = binding.organization_id
     WHERE binding.organization_id = $1
       AND binding.policy_key = $2`,
    [organizationId, policyKey],
  );
  const version = versionResult.rows[0];
  if (!version) {
    throw new Error("Active approval policy is unavailable");
  }

  const rulesResult = await client.query<{
    id: string;
    ordinal: number;
    name: string;
    predicate_json: unknown;
    outcome_json: unknown;
    reason_code: string;
  }>(
    `SELECT
       id,
       ordinal,
       name,
       predicate_json,
       outcome_json,
       reason_code
     FROM approval_policy_rules
     WHERE organization_id = $1
       AND policy_version_id = $2
     ORDER BY ordinal`,
    [organizationId, version.id],
  );

  return declarativeApprovalPolicyVersionSchema.parse({
    id: version.id,
    organizationId: version.organization_id,
    policyKey: version.policy_key,
    versionNumber: version.version_number,
    schemaVersion: version.schema_version,
    humanLabel: version.human_label,
    contentHash: version.content_hash,
    rules: rulesResult.rows.map((rule) => ({
      id: rule.id,
      ordinal: rule.ordinal,
      name: rule.name,
      predicate: rule.predicate_json,
      outcome: rule.outcome_json,
      reasonCode: rule.reason_code,
    })),
  });
}

export type ApprovalPolicyRuleDraft = Omit<DeclarativeApprovalPolicyRule, "id">;

export async function createApprovalPolicyVersion(
  pool: DatabasePool,
  input: {
    principal: ApplicationPrincipal;
    organizationId: string;
    policyKey?: string;
    versionNumber: number;
    humanLabel: string;
    description: string;
    supersedesVersionId?: string;
    rules: readonly ApprovalPolicyRuleDraft[];
  },
): Promise<{ policyVersionId: string; contentHash: string }> {
  requireOrganizationPermission(
    input.principal,
    input.organizationId,
    "approval_policy.author",
  );
  const policyVersionId = randomUUID();
  const rules = input.rules.map((rule) =>
    approvalPolicyRuleSchema.omit({ id: true }).parse(rule),
  );
  const contentHash = sha256(rules);

  return withOrganizationScope(
    pool,
    {
      userId: input.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      await client.query(
        `SELECT create_approval_policy_version(
           $1, $2, $3, $4, 'approval-policy.v1', $5, $6, $7, $8, $9::jsonb
         )`,
        [
          policyVersionId,
          input.organizationId,
          input.policyKey ?? "issue_intake",
          input.versionNumber,
          input.humanLabel,
          input.description,
          contentHash,
          input.supersedesVersionId ?? null,
          JSON.stringify(rules),
        ],
      );
      return { policyVersionId, contentHash };
    },
  );
}

function hasPermission(
  principal: ApplicationPrincipal,
  organizationId: string,
  permission: string,
): boolean {
  return (
    principal.organizationIds.includes(organizationId) &&
    (principal.permissionsByOrganization[organizationId] ?? []).includes(
      permission,
    )
  );
}

export async function requestApprovalPolicyActivation(
  pool: DatabasePool,
  input: {
    principal: ApplicationPrincipal;
    organizationId: string;
    policyVersionId: string;
    reason: string;
    commandId: string;
    context: RequestContext;
  },
): Promise<{ activationRequestId: string }> {
  if (
    !hasPermission(
      input.principal,
      input.organizationId,
      "approval_policy.author",
    ) &&
    !hasPermission(
      input.principal,
      input.organizationId,
      "approval_policy.activate",
    )
  ) {
    throw new DomainError(
      403,
      "permission_denied",
      "Approval policy author or activation permission is required",
    );
  }
  const activationRequestId = randomUUID();

  return withOrganizationScope(
    pool,
    {
      userId: input.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      await client.query(
        `SELECT request_approval_policy_activation(
           $1, $2, 'issue_intake', $3, $4, $5, $6
         )`,
        [
          activationRequestId,
          input.organizationId,
          input.policyVersionId,
          input.reason,
          input.commandId,
          input.context.traceId,
        ],
      );
      return { activationRequestId };
    },
  );
}

export interface PolicyActivationResult {
  activationId: string;
  previousPolicyVersionId: string;
  activatedPolicyVersionId: string;
  activationMode: "new_version" | "revert";
  bindingVersion: number;
}

export async function activateApprovalPolicy(
  pool: DatabasePool,
  input: {
    principal: ApplicationPrincipal;
    organizationId: string;
    policyVersionId: string;
    activationRequestId?: string;
    reason: string;
    commandId: string;
    context: RequestContext;
  },
): Promise<PolicyActivationResult> {
  requireOrganizationPermission(
    input.principal,
    input.organizationId,
    "approval_policy.activate",
  );
  const activationId = randomUUID();

  return withOrganizationScope(
    pool,
    {
      userId: input.principal.userId,
      organizationIds: [input.organizationId],
    },
    async (client) => {
      const activation = await client.query<{
        activation_id: string;
        previous_policy_version_id: string;
        activated_policy_version_id: string;
        activation_mode: "new_version" | "revert";
        binding_version: number;
      }>(
        `SELECT *
         FROM activate_approval_policy(
           $1, $2, 'issue_intake', $3, $4, $5, $6, $7
         )`,
        [
          activationId,
          input.organizationId,
          input.policyVersionId,
          input.activationRequestId ?? null,
          input.reason,
          input.commandId,
          input.context.traceId,
        ],
      );
      const row = activation.rows[0];
      if (!row) {
        throw new Error("Policy activation did not return a result");
      }

      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: input.principal.userId,
        eventType: "approval_policy.activated",
        sourceRecordIds: [],
        inputHash: sha256({
          previousPolicyVersionId: row.previous_policy_version_id,
          policyVersionId: row.activated_policy_version_id,
        }),
        outputHash: sha256(row),
        traceId: input.context.traceId,
        requestId: input.context.requestId,
        metadata: {
          activationId: row.activation_id,
          previousPolicyVersionId: row.previous_policy_version_id,
          activatedPolicyVersionId: row.activated_policy_version_id,
          activationMode: row.activation_mode,
          bindingVersion: row.binding_version,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });

      return {
        activationId: row.activation_id,
        previousPolicyVersionId: row.previous_policy_version_id,
        activatedPolicyVersionId: row.activated_policy_version_id,
        activationMode: row.activation_mode,
        bindingVersion: row.binding_version,
      };
    },
  );
}
