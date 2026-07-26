import { z } from "zod";
import type { DatabasePool } from "@operating-layer/db";
import { DomainError } from "./errors.js";
import { resolveApplicationPrincipal } from "./identity.js";
import { createManualIssue } from "./service.js";

/**
 * TractionOS -> operating-layer issue bridge.
 *
 * TractionOS is the live L10 meeting platform where humans surface issues.
 * This bridge reads flagged issues from Traction's database and hands them to
 * the existing manual-intake service, so a meeting issue becomes a governed
 * task: classified, brain-grounded, recommended, human-approved, executed,
 * audited.
 *
 * Posture, same as every live capability here:
 * - Disabled by default; enabling requires TRACTION_BRIDGE_ENABLED=true plus
 *   an explicit database URL, status flag list, and service-user email.
 * - Strictly read-only against Traction: every bridge connection is forced
 *   into read-only transactions at the session level. The live meeting tool
 *   is never written to.
 * - Flagged-only: only issues whose status is in the configured list are
 *   synced (recommended: "tabled" — the meeting's own "we can't solve this
 *   here"). Nothing is synced wholesale.
 * - Idempotent: the intake idempotency key is derived from the Traction issue
 *   id, so re-running the sync can never create duplicates.
 * - The bridge acts as a real provisioned operating-layer user (resolved by
 *   email) and therefore inherits real permissions and RLS scoping.
 */

export const TRACTION_ISSUE_STATUSES = [
  "open",
  "ids_in_progress",
  "resolved",
  "tabled",
] as const;

const DEFAULT_ORG_CODE_MAP: Record<string, string> = {
  FS: "FS",
  BL: "BLCS",
  USA: "USA",
};

export const tractionBridgeConfigSchema = z.object({
  enabled: z.literal(true),
  tractionDatabaseUrl: z.string().min(1),
  statuses: z.array(z.enum(TRACTION_ISSUE_STATUSES)).min(1),
  // Internal service emails like admin@local.operating-layer are valid here;
  // zod's strict .email() rejects hyphenated final labels.
  serviceUserEmail: z.string().regex(/^\S+@\S+$/),
  orgCodeMap: z.record(z.string().min(1)).default(DEFAULT_ORG_CODE_MAP),
  batchLimit: z.number().int().min(1).max(500).default(100),
});
export type TractionBridgeConfig = z.infer<typeof tractionBridgeConfigSchema>;

export interface TractionBridgeEnv {
  TRACTION_BRIDGE_ENABLED?: string;
  TRACTION_DATABASE_URL?: string;
  TRACTION_BRIDGE_STATUSES?: string;
  TRACTION_BRIDGE_USER_EMAIL?: string;
  TRACTION_BRIDGE_ORG_CODE_MAP?: string;
  TRACTION_BRIDGE_BATCH_LIMIT?: string;
}

export function resolveTractionBridgeConfig(
  env: TractionBridgeEnv = process.env as TractionBridgeEnv,
): TractionBridgeConfig {
  if (env.TRACTION_BRIDGE_ENABLED !== "true") {
    throw new DomainError(
      409,
      "traction_bridge_disabled",
      "The Traction bridge is disabled; set TRACTION_BRIDGE_ENABLED=true explicitly",
    );
  }
  if (!env.TRACTION_DATABASE_URL) {
    throw new Error("TRACTION_BRIDGE_ENABLED requires TRACTION_DATABASE_URL");
  }
  if (!env.TRACTION_BRIDGE_STATUSES) {
    throw new Error(
      "TRACTION_BRIDGE_ENABLED requires TRACTION_BRIDGE_STATUSES (e.g. tabled)",
    );
  }
  if (!env.TRACTION_BRIDGE_USER_EMAIL) {
    throw new Error(
      "TRACTION_BRIDGE_ENABLED requires TRACTION_BRIDGE_USER_EMAIL",
    );
  }
  return tractionBridgeConfigSchema.parse({
    enabled: true,
    tractionDatabaseUrl: env.TRACTION_DATABASE_URL,
    statuses: env.TRACTION_BRIDGE_STATUSES.split(",")
      .map((status) => status.trim())
      .filter((status) => status.length > 0),
    serviceUserEmail: env.TRACTION_BRIDGE_USER_EMAIL,
    ...(env.TRACTION_BRIDGE_ORG_CODE_MAP
      ? { orgCodeMap: JSON.parse(env.TRACTION_BRIDGE_ORG_CODE_MAP) }
      : {}),
    ...(env.TRACTION_BRIDGE_BATCH_LIMIT
      ? { batchLimit: Number(env.TRACTION_BRIDGE_BATCH_LIMIT) }
      : {}),
  });
}

const tractionIssueRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  priority: z.string(),
  status: z.enum(TRACTION_ISSUE_STATUSES),
  root_cause: z.string().nullable(),
  org_code: z.string(),
  org_name: z.string(),
  owner_name: z.string().nullable(),
  owner_email: z.string().nullable(),
  created_at: z.union([z.string(), z.date()]),
});
type TractionIssueRow = z.infer<typeof tractionIssueRowSchema>;

export interface TractionSyncSkip {
  tractionIssueId: string;
  reason: string;
}

export interface TractionSyncResult {
  scanned: number;
  created: number;
  replayed: number;
  skipped: TractionSyncSkip[];
}

function clamp(value: string, minimum: number, maximum: number): string {
  const trimmed = value.trim();
  const padded =
    trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, ".");
  return padded.slice(0, maximum);
}

function describeIssue(row: TractionIssueRow): string {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at);
  const lines = [
    `Issue raised in the ${row.org_name} L10 meeting (TractionOS).`,
    `Traction issue id: ${row.id}`,
    `Status when synced: ${row.status}; meeting priority: ${row.priority}.`,
    row.owner_name
      ? `Meeting owner: ${row.owner_name}${row.owner_email ? ` <${row.owner_email}>` : ""}.`
      : null,
    row.root_cause ? `Root cause noted in meeting: ${row.root_cause}` : null,
    `Raised at: ${createdAt}.`,
  ].filter((line): line is string => line !== null);
  return clamp(lines.join("\n"), 3, 10_000);
}

/**
 * Reads flagged issues from Traction (read-only) and feeds them through the
 * existing manual-intake service. Safe to re-run: intake idempotency replays
 * previously synced issues instead of duplicating them.
 */
export async function syncTractionIssues(
  operatingPool: DatabasePool,
  tractionPool: DatabasePool,
  config: TractionBridgeConfig,
  organizationIdsByCode: Record<string, string>,
): Promise<TractionSyncResult> {
  const principal = await resolveApplicationPrincipal(operatingPool, {
    issuer: "traction-bridge",
    subject: config.serviceUserEmail,
    email: config.serviceUserEmail,
  });

  // Pin one connection and force it read-only for its whole lifetime, so
  // every statement the bridge runs against Traction is guaranteed read-only
  // regardless of the connection role's own privileges.
  const traction = await tractionPool.connect();
  let rows: { rows: TractionIssueRow[] };
  try {
    await traction.query(
      "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
    );
    rows = await traction.query<TractionIssueRow>(
      `SELECT
         issue.id,
         issue.title,
         issue.priority::text AS priority,
         issue.status::text AS status,
         issue.root_cause,
         organization.code AS org_code,
         organization.name AS org_name,
         owner.name AS owner_name,
         owner.email AS owner_email,
         issue.created_at
       FROM issues issue
       JOIN organizations organization ON organization.id = issue.org_id
       LEFT JOIN people owner ON owner.id = issue.owner_id
       WHERE issue.status::text = ANY($1)
       ORDER BY issue.created_at ASC
       LIMIT $2`,
      [config.statuses, config.batchLimit],
    );
  } finally {
    traction.release();
  }

  const result: TractionSyncResult = {
    scanned: rows.rows.length,
    created: 0,
    replayed: 0,
    skipped: [],
  };

  for (const raw of rows.rows) {
    const parsedRow = tractionIssueRowSchema.safeParse(raw);
    if (!parsedRow.success) {
      result.skipped.push({
        tractionIssueId: String((raw as { id?: unknown }).id ?? "unknown"),
        reason: "row failed validation",
      });
      continue;
    }
    const row = parsedRow.data;
    const operatingCode = config.orgCodeMap[row.org_code];
    const organizationId = operatingCode
      ? organizationIdsByCode[operatingCode]
      : undefined;
    if (!organizationId) {
      result.skipped.push({
        tractionIssueId: row.id,
        reason: `no organization mapping for Traction code ${row.org_code}`,
      });
      continue;
    }

    try {
      const response = await createManualIssue(operatingPool, {
        principal,
        input: {
          organizationId,
          title: clamp(row.title, 3, 200),
          description: describeIssue(row),
          retentionClassification: "operational",
        },
        idempotencyKey: `traction:${row.id}`,
        context: {
          traceId: `traction-issue-${row.id}`,
          requestId: `traction-bridge-${row.id}`,
        },
      });
      if (response.duplicate) {
        result.replayed += 1;
      } else {
        result.created += 1;
      }
    } catch (error) {
      result.skipped.push({
        tractionIssueId: row.id,
        reason:
          error instanceof DomainError
            ? `${error.code}: ${error.message}`
            : "intake failed",
      });
    }
  }

  return result;
}

/**
 * Resolves the operating-layer organization ids for the mapped codes. Kept
 * separate so callers can scope RLS correctly and tests can inject fixtures.
 */
export async function loadOrganizationIdsByCode(
  operatingPool: DatabasePool,
): Promise<Record<string, string>> {
  const result = await operatingPool.query<{ id: string; code: string }>(
    `SELECT id, code FROM operating_layer.organizations`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.code, row.id]));
}
