import { appendAuditEvent, sha256 } from "@operating-layer/audit";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import { inspectMailDraftStructuralSafety } from "@operating-layer/executors";
import {
  mailDraftPilotClaimInputSchema,
  mailDraftPilotClaimResponseSchema,
  mailDraftPilotPreflightInputSchema,
  mailDraftPilotPreflightResponseSchema,
  type MailDraftPilotClaimInput,
  type MailDraftPilotClaimResponse,
  type MailDraftPilotPreflightInput,
  type MailDraftPilotPreflightResponse,
} from "@operating-layer/schemas";
import { DomainError } from "./errors.js";
import {
  claimIdempotentCommand,
  completeIdempotentCommand,
  ensureIdempotencyKey,
} from "./idempotency.js";
import {
  requireOrganizationPermission,
  type ApplicationPrincipal,
} from "./identity.js";
import type { RequestContext } from "./service.js";

interface ActiveOrganizationRow {
  id: string;
}

async function activeOrganizationIds(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
): Promise<string[]> {
  const result = await pool.query<ActiveOrganizationRow>(
    `SELECT id
     FROM operating_layer.organizations
     WHERE status = 'active'
     ORDER BY id`,
  );
  const ids = result.rows.map((row) => row.id);
  for (const organizationId of ids) {
    requireOrganizationPermission(principal, organizationId, "admin.manage");
  }
  return ids;
}

export async function setMailDraftPilotClaim(
  pool: DatabasePool,
  command: {
    principal: ApplicationPrincipal;
    input: MailDraftPilotClaimInput;
    idempotencyKey: string;
    context: RequestContext;
  },
): Promise<MailDraftPilotClaimResponse> {
  const input = mailDraftPilotClaimInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "connectors.admin",
  );
  const organizationIds = await activeOrganizationIds(pool, command.principal);
  const idempotencyKey = ensureIdempotencyKey(command.idempotencyKey);
  const requestHash = sha256(input);
  const scope = "mail_draft_live_pilot_claim";

  return withOrganizationScope(
    pool,
    { userId: command.principal.userId, organizationIds },
    async (client) => {
      const claim = await claimIdempotentCommand<MailDraftPilotClaimResponse>(
        client,
        {
          organizationId: input.organizationId,
          scope,
          idempotencyKey,
          requestHash,
        },
      );
      if (claim.kind === "replay") {
        return { ...claim.response, duplicate: true };
      }

      const functionName =
        input.action === "claim"
          ? "claim_mail_draft_live_pilot"
          : "release_mail_draft_live_pilot";
      const changed = await client.query<{
        organization_id: string;
        organization_code: string;
        claim_version: number;
      }>(
        `SELECT *
         FROM ${functionName}($1, $2, $3, $4)`,
        [
          input.organizationId,
          input.reason,
          command.context.traceId,
          command.context.requestId,
        ],
      );
      const row = changed.rows[0];
      if (!row) {
        throw new Error("Mail live-pilot claim did not return state");
      }
      const action = input.action === "claim" ? "claimed" : "released";
      await appendAuditEvent(client, {
        organizationId: input.organizationId,
        actorType: "user",
        actorId: command.principal.userId,
        eventType: `mail_draft.live_pilot_${action}`,
        sourceRecordIds: [],
        inputHash: requestHash,
        outputHash: sha256({
          organizationId: row.organization_id,
          organizationCode: row.organization_code,
          claimVersion: row.claim_version,
          action,
        }),
        traceId: command.context.traceId,
        requestId: command.context.requestId,
        metadata: {
          organizationCode: row.organization_code,
          claimVersion: row.claim_version,
          action,
          reason: input.reason,
        },
        occurredAt: new Date().toISOString(),
      });
      const response = mailDraftPilotClaimResponseSchema.parse({
        organizationId: row.organization_id,
        organizationCode: row.organization_code,
        action,
        claimVersion: row.claim_version,
        duplicate: false,
        traceId: command.context.traceId,
      });
      await completeIdempotentCommand(client, {
        organizationId: input.organizationId,
        scope,
        idempotencyKey,
        requestHash,
        response,
      });
      return response;
    },
  );
}

export async function inspectMailDraftPilotPreflight(
  pool: DatabasePool,
  command: {
    principal: ApplicationPrincipal;
    input: MailDraftPilotPreflightInput;
    context: RequestContext;
  },
): Promise<MailDraftPilotPreflightResponse> {
  const input = mailDraftPilotPreflightInputSchema.parse(command.input);
  requireOrganizationPermission(
    command.principal,
    input.organizationId,
    "connectors.admin",
  );
  const organizationIds = await activeOrganizationIds(pool, command.principal);
  return withOrganizationScope(
    pool,
    { userId: command.principal.userId, organizationIds },
    async (client) => {
      const inspected = await client.query<{
        organization_id: string;
        organization_code: string;
        organization_name: string;
        pilot_claim_active: boolean;
        pilot_claimed_for_target: boolean;
        target_connector_enabled: boolean;
        active_credential_present: boolean;
        credential_envelope_valid: boolean;
        credential_fingerprint_matches: boolean | null;
        exact_compose_scope: boolean;
        exact_single_recipient_allowlist: boolean;
        expected_recipient_allowed: boolean | null;
        other_enabled_organization_count: string;
        all_other_organizations_disabled: boolean;
        global_kill_cleared: boolean;
        kill_switch_reachable: boolean;
      }>(
        `SELECT *
         FROM inspect_mail_draft_live_pilot($1, $2, $3)`,
        [
          input.organizationId,
          input.expectedRecipient ?? null,
          input.expectedCredentialFingerprint ?? null,
        ],
      );
      const row = inspected.rows[0];
      if (!row) {
        throw new DomainError(
          404,
          "mail_draft_pilot_organization_not_found",
          "The live-pilot organization is not active",
        );
      }
      if (
        row.organization_code.toUpperCase() !==
        input.expectedOrganizationCode.toUpperCase()
      ) {
        throw new DomainError(
          409,
          "mail_draft_pilot_organization_mismatch",
          "The organization code does not match the requested organization ID",
        );
      }

      const structural = inspectMailDraftStructuralSafety();
      const checks = {
        pilotClaimedForTarget: row.pilot_claimed_for_target,
        targetConnectorEnabled: row.target_connector_enabled,
        activeCredentialPresent: row.active_credential_present,
        credentialEnvelopeValid: row.credential_envelope_valid,
        credentialFingerprintMatches:
          row.credential_fingerprint_matches === true,
        exactComposeScope: row.exact_compose_scope,
        exactSingleRecipientAllowlist: row.exact_single_recipient_allowlist,
        expectedRecipientAllowed: row.expected_recipient_allowed === true,
        allOtherOrganizationsDisabled: row.all_other_organizations_disabled,
        globalKillCleared: row.global_kill_cleared,
        killSwitchReachable: row.kill_switch_reachable,
        structuralNoSend: structural.structuralNoSend,
      };
      const readyForLiveDraft = Object.values(checks).every(Boolean);
      const disabledByDefault =
        !row.pilot_claim_active &&
        !row.target_connector_enabled &&
        !row.active_credential_present &&
        row.all_other_organizations_disabled &&
        row.kill_switch_reachable &&
        structural.structuralNoSend;
      return mailDraftPilotPreflightResponseSchema.parse({
        organizationId: row.organization_id,
        organizationCode: row.organization_code,
        organizationName: row.organization_name,
        pilotClaimActive: row.pilot_claim_active,
        pilotClaimedForTarget: row.pilot_claimed_for_target,
        targetConnectorEnabled: row.target_connector_enabled,
        activeCredentialPresent: row.active_credential_present,
        credentialEnvelopeValid: row.credential_envelope_valid,
        credentialFingerprintMatches: row.credential_fingerprint_matches,
        exactComposeScope: row.exact_compose_scope,
        exactSingleRecipientAllowlist: row.exact_single_recipient_allowlist,
        expectedRecipientAllowed: row.expected_recipient_allowed,
        otherEnabledOrganizationCount: Number(
          row.other_enabled_organization_count,
        ),
        allOtherOrganizationsDisabled: row.all_other_organizations_disabled,
        globalKillCleared: row.global_kill_cleared,
        killSwitchReachable: row.kill_switch_reachable,
        structuralNoSend: structural.structuralNoSend,
        readyForLiveDraft,
        disabledByDefault,
        checks,
        traceId: command.context.traceId,
      });
    },
  );
}
