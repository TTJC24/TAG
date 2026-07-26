import { z } from "zod";
import type { DatabasePool } from "@operating-layer/db";
import { DomainError } from "./errors.js";
import { resolveApplicationPrincipal } from "./identity.js";
import { createManualIssue } from "./service.js";

/**
 * Sales doorway: Pipedrive is canonical for pursuit state; this raises the
 * obligations, it does not duplicate deal state.
 *
 * Pipedrive holds the deals (owner decision: canonical for bids/deals). This
 * doorway reads them (read-only) and turns *deals that need attention* — past
 * their expected close, gone quiet, or with no next step — into governed
 * follow-ups in the tower for approval. It never writes to Pipedrive and never
 * mirrors the pipeline; the deal record stays the source of truth.
 *
 * Posture (same discipline as every other doorway):
 * - Deterministic: the rules are data (ATTENTION_RULES), evaluated against the
 *   deal's own dates/value. No model decides what is "stale."
 * - One governed follow-up per flagged deal, carrying every reason it fired.
 * - Idempotent per `pipedrive:<orgCode>:<dealId>:<asOf>`: re-running a scan
 *   replays; the next scan day re-raises a deal that is still adrift.
 * - Inert by default: enabling requires PIPEDRIVE_SALES_* set explicitly.
 * - Pipeline -> entity is configuration (a Pipedrive account can run one
 *   pipeline per company or a shared one); the owner supplies the map.
 */

/** Lenient view of a Pipedrive deal — only the fields the rules use. */
export const pipedriveDealSchema = z
  .object({
    id: z.number(),
    title: z.string().min(1),
    value: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    status: z.string(), // open | won | lost | deleted
    pipeline_id: z.number().nullable().optional(),
    stage_id: z.number().nullable().optional(),
    expected_close_date: z.string().nullable().optional(), // YYYY-MM-DD
    last_activity_date: z.string().nullable().optional(),
    next_activity_date: z.string().nullable().optional(),
    org_name: z.string().nullable().optional(),
    person_name: z.string().nullable().optional(),
    owner_name: z.string().nullable().optional(),
  })
  .passthrough();
export type PipedriveDeal = z.infer<typeof pipedriveDealSchema>;

export type AttentionReason =
  | "past_expected_close"
  | "no_activity"
  | "no_next_step";

export interface AttentionRule {
  reason: AttentionReason;
  priority: number; // higher = more urgent; drives the headline reason
  label: string;
}

/** The attention rules, as data. Ordered by urgency. */
export const ATTENTION_RULES: Record<AttentionReason, AttentionRule> = {
  past_expected_close: {
    reason: "past_expected_close",
    priority: 3,
    label: "past its expected close date",
  },
  no_activity: {
    reason: "no_activity",
    priority: 2,
    label: "no activity logged recently",
  },
  no_next_step: {
    reason: "no_next_step",
    priority: 1,
    label: "no next step scheduled",
  },
};

export interface SalesThresholds {
  staleDays: number; // days without activity before "no_activity" fires
}

export const DEFAULT_THRESHOLDS: SalesThresholds = { staleDays: 14 };

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Which attention reasons a single open deal trips, most urgent first. */
export function reasonsFor(
  deal: PipedriveDeal,
  asOf: string,
  thresholds: SalesThresholds = DEFAULT_THRESHOLDS,
): AttentionRule[] {
  if (deal.status !== "open") return [];
  const fired: AttentionRule[] = [];

  if (deal.expected_close_date) {
    const overdueBy = daysBetween(deal.expected_close_date, asOf);
    if (overdueBy !== null && overdueBy > 0) {
      fired.push(ATTENTION_RULES.past_expected_close);
    }
  }
  if (deal.last_activity_date) {
    const quietFor = daysBetween(deal.last_activity_date, asOf);
    if (quietFor !== null && quietFor >= thresholds.staleDays) {
      fired.push(ATTENTION_RULES.no_activity);
    }
  } else {
    // Never any activity logged — treat as quiet.
    fired.push(ATTENTION_RULES.no_activity);
  }
  if (!deal.next_activity_date) {
    fired.push(ATTENTION_RULES.no_next_step);
  }

  return fired.sort((a, b) => b.priority - a.priority);
}

export interface PipedriveSalesEnv {
  PIPEDRIVE_SALES_ENABLED?: string;
  PIPEDRIVE_SALES_USER_EMAIL?: string;
  PIPEDRIVE_SALES_STALE_DAYS?: string;
  PIPEDRIVE_PIPELINE_ORG_MAP?: string; // JSON {"<pipeline_id>":"FS", ...}
}

export interface PipedriveSalesConfig {
  serviceUserEmail: string;
  thresholds: SalesThresholds;
  pipelineToOrgCode: Record<string, string>;
}

export function resolvePipedriveSalesConfig(
  env: PipedriveSalesEnv = process.env as PipedriveSalesEnv,
): PipedriveSalesConfig {
  if (env.PIPEDRIVE_SALES_ENABLED !== "true") {
    throw new DomainError(
      409,
      "pipedrive_sales_disabled",
      "The Sales doorway is disabled; set PIPEDRIVE_SALES_ENABLED=true explicitly",
    );
  }
  if (!env.PIPEDRIVE_SALES_USER_EMAIL) {
    throw new Error("PIPEDRIVE_SALES_ENABLED requires PIPEDRIVE_SALES_USER_EMAIL");
  }
  const staleDays = Number.parseInt(env.PIPEDRIVE_SALES_STALE_DAYS ?? "14", 10);
  let pipelineToOrgCode: Record<string, string> = {};
  if (env.PIPEDRIVE_PIPELINE_ORG_MAP) {
    try {
      pipelineToOrgCode = JSON.parse(env.PIPEDRIVE_PIPELINE_ORG_MAP);
    } catch {
      throw new Error("PIPEDRIVE_PIPELINE_ORG_MAP must be valid JSON");
    }
  }
  return {
    serviceUserEmail: env.PIPEDRIVE_SALES_USER_EMAIL,
    thresholds: { staleDays: Number.isFinite(staleDays) ? staleDays : 14 },
    pipelineToOrgCode,
  };
}

/**
 * One Pipedrive account and how its deals route to orgs. The group runs two:
 * one holds FS (everything -> FS), the other holds BL + USA (routed by
 * pipeline). Tokens are held per-source, resolved from their own env var so a
 * secret never sits inside the JSON config blob.
 */
export interface PipedriveSource {
  name: string;
  apiBase: string;
  token: string;
  orgCode?: string; // whole account routes to one org (e.g. the FS account)
  pipelineToOrgCode?: Record<string, string>; // split by pipeline (e.g. BL/USA)
}

const pipedriveSourceConfigSchema = z.object({
  name: z.string().min(1),
  apiBase: z.string().url(),
  tokenEnv: z.string().min(1),
  orgCode: z.string().min(1).optional(),
  pipelineToOrgCode: z.record(z.string()).optional(),
});

/**
 * Resolve the configured Pipedrive accounts. PIPEDRIVE_SOURCES is a JSON array
 * of {name, apiBase, tokenEnv, orgCode?, pipelineToOrgCode?}; each source's
 * token is read from the env var it names. A source must route somehow (a fixed
 * orgCode or a pipeline map), else it is a misconfiguration.
 */
export function resolvePipedriveSources(
  env: Record<string, string | undefined> = process.env,
): PipedriveSource[] {
  const raw = env.PIPEDRIVE_SOURCES;
  if (!raw) {
    throw new Error("PIPEDRIVE_SOURCES is required (JSON array of accounts)");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error("PIPEDRIVE_SOURCES must be valid JSON");
  }
  const entries = z.array(pipedriveSourceConfigSchema).parse(parsedJson);
  return entries.map((entry) => {
    const token = env[entry.tokenEnv];
    if (!token) {
      throw new Error(
        `Pipedrive source "${entry.name}" needs ${entry.tokenEnv} set`,
      );
    }
    if (!entry.orgCode && !entry.pipelineToOrgCode) {
      throw new Error(
        `Pipedrive source "${entry.name}" needs an orgCode or a pipelineToOrgCode map`,
      );
    }
    return {
      name: entry.name,
      apiBase: entry.apiBase,
      token,
      ...(entry.orgCode ? { orgCode: entry.orgCode } : {}),
      ...(entry.pipelineToOrgCode
        ? { pipelineToOrgCode: entry.pipelineToOrgCode }
        : {}),
    };
  });
}

export interface SalesFollowup {
  orgCode: string;
  dealId: number;
  title: string;
  description: string;
  dueDate: string | null;
  idempotencyKey: string;
  headline: AttentionReason;
}

function clampText(value: string, minimum: number, maximum: number): string {
  const trimmed = value.trim();
  const padded = trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, ".");
  return padded.slice(0, maximum);
}

function money(deal: PipedriveDeal): string {
  if (deal.value == null) return "value not set";
  return `${deal.currency ?? ""} ${deal.value.toLocaleString("en-US")}`.trim();
}

/**
 * Pure transform: deals + scan date -> the follow-ups we would raise. No
 * database, no Pipedrive write, so the whole "which deals need attention and
 * why" decision is unit-testable.
 */
export function buildSalesFollowups(
  deals: PipedriveDeal[],
  opts: {
    asOf: string;
    orgCode?: string;
    pipelineToOrgCode?: Record<string, string>;
    thresholds?: SalesThresholds;
  },
): SalesFollowup[] {
  const map = opts.pipelineToOrgCode ?? {};
  const followups: SalesFollowup[] = [];

  for (const deal of deals) {
    const reasons = reasonsFor(deal, opts.asOf, opts.thresholds ?? DEFAULT_THRESHOLDS);
    if (reasons.length === 0) continue;

    const orgCode =
      opts.orgCode ??
      (deal.pipeline_id != null ? map[String(deal.pipeline_id)] : undefined);
    if (!orgCode) continue; // unmapped pipeline: skip rather than misroute

    const headline = reasons[0]!;
    const description = clampText(
      [
        `Deal "${deal.title}" (Pipedrive #${deal.id}) needs attention.`,
        deal.org_name ? `Account: ${deal.org_name}` : null,
        deal.person_name ? `Contact: ${deal.person_name}` : null,
        `Value: ${money(deal)}`,
        deal.expected_close_date ? `Expected close: ${deal.expected_close_date}` : null,
        deal.last_activity_date ? `Last activity: ${deal.last_activity_date}` : `Last activity: none`,
        `Flags: ${reasons.map((r) => r.label).join("; ")}.`,
        `Pipedrive is canonical for the deal itself — update the deal there. This follow-up only tracks that the next move happens; it does not change deal state.`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      3,
      10_000,
    );

    followups.push({
      orgCode,
      dealId: deal.id,
      title: clampText(
        `Sales: ${deal.title} — ${headline.label} (${money(deal)})`,
        3,
        200,
      ),
      description,
      dueDate: deal.expected_close_date ?? null,
      idempotencyKey: `pipedrive:${orgCode}:${deal.id}:${opts.asOf}`,
      headline: headline.reason,
    });
  }

  return followups;
}

export interface PipedriveSalesSyncSkip {
  dealId: number;
  reason: string;
}

export interface PipedriveSalesSyncResult {
  asOf: string;
  scanned: number;
  created: number;
  replayed: number;
  skipped: PipedriveSalesSyncSkip[];
}

/**
 * Feed Pipedrive deals through governed intake. One follow-up per flagged deal,
 * idempotent per deal + scan date. Mirrors the proven createManualIssue path.
 */
export async function syncPipedriveDeals(
  operatingPool: DatabasePool,
  rawDeals: unknown[],
  config: PipedriveSalesConfig,
  organizationIdsByCode: Record<string, string>,
  asOf: string,
  opts: { orgCode?: string; pipelineToOrgCode?: Record<string, string> } = {},
): Promise<PipedriveSalesSyncResult> {
  const result: PipedriveSalesSyncResult = {
    asOf,
    scanned: 0,
    created: 0,
    replayed: 0,
    skipped: [],
  };

  const deals: PipedriveDeal[] = [];
  for (const raw of rawDeals) {
    const parsed = pipedriveDealSchema.safeParse(raw);
    if (!parsed.success) {
      result.skipped.push({
        dealId: Number((raw as { id?: unknown })?.id ?? -1),
        reason: "deal failed validation",
      });
      continue;
    }
    result.scanned += 1;
    deals.push(parsed.data);
  }

  const followups = buildSalesFollowups(deals, {
    asOf,
    ...(opts.orgCode ? { orgCode: opts.orgCode } : {}),
    pipelineToOrgCode: opts.pipelineToOrgCode ?? config.pipelineToOrgCode,
    thresholds: config.thresholds,
  });
  if (followups.length === 0) return result;

  const principal = await resolveApplicationPrincipal(operatingPool, {
    issuer: "pipedrive-sales",
    subject: config.serviceUserEmail,
    email: config.serviceUserEmail,
  });

  for (const followup of followups) {
    const organizationId = organizationIdsByCode[followup.orgCode];
    if (!organizationId) {
      result.skipped.push({
        dealId: followup.dealId,
        reason: `no organization for code ${followup.orgCode}`,
      });
      continue;
    }
    try {
      const response = await createManualIssue(operatingPool, {
        principal,
        input: {
          organizationId,
          title: followup.title,
          description: followup.description,
          ...(followup.dueDate ? { dueDate: followup.dueDate } : {}),
          retentionClassification: "operational",
        },
        idempotencyKey: followup.idempotencyKey,
        context: {
          traceId: `pipedrive-${followup.idempotencyKey}`,
          requestId: `pipedrive-${followup.orgCode}-${followup.dealId}`,
        },
      });
      if (response.duplicate) result.replayed += 1;
      else result.created += 1;
    } catch (error) {
      if (error instanceof DomainError && error.code === "idempotency_key_conflict") {
        result.replayed += 1;
        continue;
      }
      result.skipped.push({
        dealId: followup.dealId,
        reason:
          error instanceof DomainError
            ? `${error.code}: ${error.message}`
            : "intake failed",
      });
    }
  }

  return result;
}
