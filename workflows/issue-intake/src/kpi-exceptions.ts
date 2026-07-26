import { z } from "zod";
import type { DatabasePool } from "@operating-layer/db";
import type { CompanyBrainQueryClient } from "@operating-layer/connectors";
import { DomainError } from "./errors.js";
import { resolveApplicationPrincipal } from "./identity.js";
import { createManualIssue } from "./service.js";

/**
 * KPI exception scanner: the "numbers watch themselves" doorway.
 *
 * Scoreboard owns the certified KPI/control definitions (its kpi-spec and
 * promotion-evidence ledger). This scanner turns a certified exception
 * definition — stale opportunities, stuck orders, dead stock — into governed
 * intake: each firing row becomes an issue that is classified, recommended,
 * human-approved where required, executed, and audited.
 *
 * Discipline carried over from scoreboard's own rules:
 * - A definition whose `certified` flag is not true is SKIPPED, not run.
 *   Scoreboard's ledger requires source mapping, validation, freshness, and
 *   owner approval before anything is treated as certified; this scanner
 *   enforces that gate in code. A development-only override exists and must
 *   be set explicitly.
 * - Data is read exclusively through company-brain's read-only query service;
 *   the scanner never touches Acumatica or Pipedrive directly and never
 *   writes to any source system.
 * - Definitions are declarative data (SQL + column contract), never prompts.
 * - Idempotency: `kpi:<definitionId>:<recordKey>` — a firing record raises
 *   one issue. After the idempotency retention window (7 days, ADR 0002) a
 *   still-firing record resurfaces deliberately: an exception nobody resolved
 *   should come back.
 */

export const kpiExceptionDefinitionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,63}$/)
    .describe("stable slug, e.g. stale-opportunities-fs"),
  name: z.string().min(3).max(120),
  entityCode: z.enum(["BLCS", "FS", "USA", "CULTIVUS"]),
  certified: z.boolean(),
  promotionEvidence: z.string().min(1).optional(),
  sql: z.string().min(10),
  recordKeyColumn: z.string().min(1),
  titleTemplate: z.string().min(3).max(160),
  summaryColumns: z.array(z.string().min(1)).min(1).max(12),
  rowLimit: z.number().int().min(1).max(500).default(200),
});
export type KpiExceptionDefinition = z.infer<
  typeof kpiExceptionDefinitionSchema
>;

export const kpiExceptionDefinitionsFileSchema = z.object({
  definitions: z.array(kpiExceptionDefinitionSchema).min(1),
});

export interface KpiExceptionScanOptions {
  serviceUserEmail: string;
  /** Development-only: run definitions that are not certified. */
  allowUncertified?: boolean;
}

export interface KpiExceptionSkip {
  definitionId: string;
  recordKey?: string;
  reason: string;
}

export interface KpiExceptionScanResult {
  definitionsRun: number;
  rowsScanned: number;
  created: number;
  replayed: number;
  skipped: KpiExceptionSkip[];
}

export interface KpiExceptionEnv {
  KPI_EXCEPTIONS_ENABLED?: string;
  BRAIN_QUERY_URL?: string;
  KPI_EXCEPTIONS_USER_EMAIL?: string;
  KPI_EXCEPTIONS_ALLOW_UNCERTIFIED?: string;
}

export interface KpiExceptionConfig {
  brainQueryUrl: string;
  serviceUserEmail: string;
  allowUncertified: boolean;
}

export function resolveKpiExceptionConfig(
  env: KpiExceptionEnv = process.env as KpiExceptionEnv,
): KpiExceptionConfig {
  if (env.KPI_EXCEPTIONS_ENABLED !== "true") {
    throw new DomainError(
      409,
      "kpi_exceptions_disabled",
      "KPI exception scanning is disabled; set KPI_EXCEPTIONS_ENABLED=true explicitly",
    );
  }
  if (!env.BRAIN_QUERY_URL) {
    throw new Error("KPI_EXCEPTIONS_ENABLED requires BRAIN_QUERY_URL");
  }
  if (!env.KPI_EXCEPTIONS_USER_EMAIL) {
    throw new Error(
      "KPI_EXCEPTIONS_ENABLED requires KPI_EXCEPTIONS_USER_EMAIL",
    );
  }
  return {
    brainQueryUrl: env.BRAIN_QUERY_URL,
    serviceUserEmail: env.KPI_EXCEPTIONS_USER_EMAIL,
    allowUncertified: env.KPI_EXCEPTIONS_ALLOW_UNCERTIFIED === "true",
  };
}

function clampText(value: string, minimum: number, maximum: number): string {
  const trimmed = value.trim();
  const padded =
    trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, ".");
  return padded.slice(0, maximum);
}

function describeException(
  definition: KpiExceptionDefinition,
  recordKey: string,
  row: Record<string, unknown>,
  scannedAt: string,
): string {
  const lines = [
    `KPI exception raised automatically by the certified definition "${definition.name}" (${definition.id}).`,
    `Record key: ${recordKey}`,
    ...definition.summaryColumns.map(
      (column) => `${column}: ${String(row[column] ?? "unknown")}`,
    ),
    `Data source: company-brain read-only query service.`,
    `Scanned at: ${scannedAt}.`,
    definition.promotionEvidence
      ? `Promotion evidence: ${definition.promotionEvidence}`
      : null,
  ].filter((line): line is string => line !== null);
  return clampText(lines.join("\n"), 3, 10_000);
}

/**
 * Runs each certified definition against the brain's query service and feeds
 * firing rows into governed intake. Re-runs are idempotent within the
 * retention window.
 */
export async function scanKpiExceptions(
  operatingPool: DatabasePool,
  queryClient: CompanyBrainQueryClient,
  definitions: KpiExceptionDefinition[],
  organizationIdsByCode: Record<string, string>,
  options: KpiExceptionScanOptions,
): Promise<KpiExceptionScanResult> {
  const principal = await resolveApplicationPrincipal(operatingPool, {
    issuer: "kpi-exception-scanner",
    subject: options.serviceUserEmail,
    email: options.serviceUserEmail,
  });

  const result: KpiExceptionScanResult = {
    definitionsRun: 0,
    rowsScanned: 0,
    created: 0,
    replayed: 0,
    skipped: [],
  };
  const scannedAt = new Date().toISOString();

  for (const rawDefinition of definitions) {
    const parsed = kpiExceptionDefinitionSchema.safeParse(rawDefinition);
    if (!parsed.success) {
      result.skipped.push({
        definitionId: String(
          (rawDefinition as { id?: unknown }).id ?? "unknown",
        ),
        reason: "definition failed validation",
      });
      continue;
    }
    const definition = parsed.data;

    if (!definition.certified && !options.allowUncertified) {
      result.skipped.push({
        definitionId: definition.id,
        reason:
          "definition is not certified (scoreboard promotion ledger); refusing to run",
      });
      continue;
    }

    const organizationId = organizationIdsByCode[definition.entityCode];
    if (!organizationId) {
      result.skipped.push({
        definitionId: definition.id,
        reason: `no organization for entity code ${definition.entityCode}`,
      });
      continue;
    }

    // Fails closed: an unreachable brain or malformed result throws to the
    // caller rather than silently reporting a clean scan.
    const queryResult = await queryClient.query(
      definition.sql,
      definition.rowLimit,
    );
    result.definitionsRun += 1;
    result.rowsScanned += queryResult.rows.length;

    for (const row of queryResult.rows) {
      const keyValue = row[definition.recordKeyColumn];
      const recordKey =
        typeof keyValue === "string" || typeof keyValue === "number"
          ? String(keyValue).trim()
          : "";
      if (!recordKey) {
        result.skipped.push({
          definitionId: definition.id,
          reason: `row is missing record key column ${definition.recordKeyColumn}`,
        });
        continue;
      }

      try {
        const response = await createManualIssue(operatingPool, {
          principal,
          input: {
            organizationId,
            title: clampText(
              `${definition.titleTemplate}: ${recordKey}`,
              3,
              200,
            ),
            description: describeException(
              definition,
              recordKey,
              row,
              scannedAt,
            ),
            retentionClassification: "operational",
          },
          idempotencyKey: `kpi:${definition.id}:${recordKey}`,
          context: {
            traceId: `kpi-${definition.id}-${recordKey}`,
            requestId: `kpi-exception-${definition.id}-${recordKey}`,
          },
        });
        if (response.duplicate) {
          result.replayed += 1;
        } else {
          result.created += 1;
        }
      } catch (error) {
        if (
          error instanceof DomainError &&
          error.code === "idempotency_key_conflict"
        ) {
          // Same record key, drifted payload (e.g. days_stale grew between
          // scans): the exception is still firing and was already raised
          // within the retention window. That is a replay, not a failure.
          result.replayed += 1;
          continue;
        }
        result.skipped.push({
          definitionId: definition.id,
          recordKey,
          reason:
            error instanceof DomainError
              ? `${error.code}: ${error.message}`
              : "intake failed",
        });
      }
    }
  }

  return result;
}
