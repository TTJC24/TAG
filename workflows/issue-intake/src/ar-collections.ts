import { randomUUID } from "node:crypto";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import { DomainError } from "./errors.js";
import { resolveApplicationPrincipal } from "./identity.js";
import { createManualIssue } from "./service.js";
import { buildChaseEmail, type ChaseEmailContext } from "./chase-email.js";
import {
  pastDue,
  worstBucket,
  type AgingBuckets,
  type AgingCustomer,
  type ParsedAging,
} from "./ar-aging.js";

/**
 * Collections doorway: past-due AR becomes governed, drafted chases.
 *
 * The AR aging (Detailed) export is parsed by ar-aging.ts; this turns each
 * past-due customer into a governed issue — classified, recommended, and
 * (once the Gmail-draft wire is enabled) drafted for the AR person to approve.
 * Nothing sends. The AR person is the approver, so their approvals and edits
 * are what calibrate the ladder to real practice over time.
 *
 * Posture (same as every other doorway):
 * - Deterministic: no model invents balances, customers, or which rung applies.
 *   The rung is chosen from the customer's own worst bucket.
 * - Ladder is policy DATA (DEFAULT_LADDER), never prompt text, and tunable.
 * - Idempotent per `collections:<orgCode>:<agedOn>:<customerId>`: re-running the
 *   same aging file replays; next week's file (new agedOn) raises fresh chases.
 * - Inert by default: enabling requires COLLECTIONS_* env set explicitly.
 * - USA is prepaid (no AR) and out of scope; Cultivus AR lives on a separate
 *   ledger (QuickBooks) and is a later target, not this doorway.
 */

export type LadderBucket = "d1_30" | "d31_60" | "d61_90" | "over90";

export interface LadderRung {
  step: number;
  label: string;
  guidance: string;
}

/**
 * Default three-step ladder + escalation, from the blueprint. Data, not prompt.
 * Tunable, and calibrated in practice by what the AR person approves/edits.
 */
export const DEFAULT_LADDER: Record<LadderBucket, LadderRung> = {
  d1_30: {
    step: 1,
    label: "friendly reminder",
    guidance:
      "Friendly reminder with the invoice copy; assume oversight. No pressure.",
  },
  d31_60: {
    step: 2,
    label: "firm follow-up",
    guidance:
      "Firmer follow-up with a full statement; ask for a specific payment date.",
  },
  d61_90: {
    step: 3,
    label: "final notice",
    guidance:
      "Final notice; open a human call task; confirm whether this is a dispute or a delay.",
  },
  over90: {
    step: 4,
    label: "escalation",
    guidance:
      "Escalate; flag hold-new-orders; owner/AR call required before extending further credit.",
  },
};

/** The ladder rung for a customer's aging, or null if nothing is past due. */
export function rungFor(buckets: AgingBuckets): LadderRung | null {
  const worst = worstBucket(buckets);
  if (worst === "current") return null;
  return DEFAULT_LADDER[worst];
}

export interface CollectionsBridgeEnv {
  COLLECTIONS_ENABLED?: string;
  COLLECTIONS_USER_EMAIL?: string;
  COLLECTIONS_MIN_PAST_DUE?: string;
  COLLECTIONS_SENDER_NAME?: string;
  COLLECTIONS_SENDER_CONTACT?: string;
}

export interface CollectionsConfig {
  serviceUserEmail: string;
  minPastDue: number;
  /** Who the chase is signed by. Shown to the customer, so it must be a person. */
  senderName: string;
  /** Optional reply-to / phone line under the signature. */
  senderContact?: string;
}

/** Customer-facing entity names — what a chase email signs off as. */
export const ORG_DISPLAY_NAMES: Record<string, string> = {
  FS: "Fastening Specialists",
  BLCS: "Big League Construction Supply",
  USA: "Utility Supply Associates",
};

export function resolveCollectionsConfig(
  env: CollectionsBridgeEnv = process.env as CollectionsBridgeEnv,
): CollectionsConfig {
  if (env.COLLECTIONS_ENABLED !== "true") {
    throw new DomainError(
      409,
      "collections_disabled",
      "The Collections doorway is disabled; set COLLECTIONS_ENABLED=true explicitly",
    );
  }
  if (!env.COLLECTIONS_USER_EMAIL) {
    throw new Error("COLLECTIONS_ENABLED requires COLLECTIONS_USER_EMAIL");
  }
  const minPastDue = Number.parseFloat(env.COLLECTIONS_MIN_PAST_DUE ?? "0");
  return {
    serviceUserEmail: env.COLLECTIONS_USER_EMAIL,
    minPastDue: Number.isFinite(minPastDue) ? minPastDue : 0,
    // The signature defaults to the entity's AR desk rather than a person, so
    // an unset env never leaks a placeholder name to a customer.
    senderName: env.COLLECTIONS_SENDER_NAME?.trim() || "Accounts Receivable",
    ...(env.COLLECTIONS_SENDER_CONTACT?.trim()
      ? { senderContact: env.COLLECTIONS_SENDER_CONTACT.trim() }
      : {}),
  };
}

/**
 * Map the aging report's company field to an operating-layer org code. Only
 * FS (Fastening Specialists) and BL (Big League Construction Supply) carry AR
 * in Acumatica; USA is prepaid and Cultivus is on a separate ledger. FS is the
 * same on both sides; Acumatica's "BL"/"BLC" normalize to the org code BLCS.
 * Note: FS is Fastening Specialists — distinct from FSI Acquisition Corp (the
 * real-estate propco), which is a finance entity, not an operating-layer org.
 */
export const COMPANY_TO_ORG_CODE: Record<string, string> = {
  FS: "FS", // Fastening Specialists
  BL: "BLCS",
  BLC: "BLCS",
  BLCS: "BLCS",
};

export interface CollectionsDraft {
  orgCode: string;
  customerId: string;
  customerName: string;
  title: string;
  description: string;
  dueDate: string | null;
  idempotencyKey: string;
  step: number;
  pastDue: number;
  /**
   * The composed chase text for this customer — what the approver will see
   * prefilled instead of retyping. `recipient` is null when Acumatica has no
   * AR email on file, in which case `blockedReason` says so.
   */
  email: {
    recipient: string | null;
    blockedReason: string | null;
    subject: string;
    body: string;
  };
}

function clampText(value: string, minimum: number, maximum: number): string {
  const trimmed = value.trim();
  const padded =
    trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, ".");
  return padded.slice(0, maximum);
}

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Overdue invoice lines (something in a past-due bucket), oldest due first. */
function overdueLines(customer: AgingCustomer) {
  return customer.lines
    .filter((line) => pastDue(line.buckets) !== 0)
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

function describe(
  customer: AgingCustomer,
  rung: LadderRung,
  orgCode: string,
  agedOn: string | null,
): string {
  const b = customer.buckets;
  const lines = overdueLines(customer);
  const parts = [
    `Collections chase for ${customer.customerName} (${customer.customerId}), org ${orgCode}.`,
    `Past due ${money(pastDue(b))} of ${money(b.balance)} total AR.`,
    `Aging: 1-30 ${money(b.d1_30)} · 31-60 ${money(b.d31_60)} · 61-90 ${money(b.d61_90)} · over-90 ${money(b.over90)}.`,
    `Ladder step ${rung.step} (${rung.label}): ${rung.guidance}`,
    lines.length > 0 ? `Overdue documents:` : null,
    ...lines.map(
      (l) =>
        `  - ${l.docType} ${l.refNbr} due ${l.dueDate ?? "n/a"}: ${money(l.buckets.balance)}`,
    ),
    `Source: Acumatica AR Aging (Detailed), aged ${agedOn ?? "n/a"}. Draft only; nothing sends without approval.`,
  ].filter((line): line is string => line !== null);
  return clampText(parts.join("\n"), 3, 10_000);
}

/**
 * Pure transform: parsed aging -> the chases we would raise. No database, no
 * side effects, so the whole decision (who gets chased, which rung, itemized
 * how) is unit-testable.
 */
export function buildCollectionsDrafts(
  parsed: ParsedAging,
  opts: {
    orgCode?: string;
    minPastDue?: number;
    companyToOrgCode?: Record<string, string>;
    /** Signature details for the composed chase; defaults are non-identifying. */
    sender?: { senderName: string; senderContact?: string };
  } = {},
): CollectionsDraft[] {
  const map = opts.companyToOrgCode ?? COMPANY_TO_ORG_CODE;
  const orgCode =
    opts.orgCode ?? (parsed.company ? map[parsed.company.trim().toUpperCase()] : undefined);
  if (!orgCode) return [];
  const minPastDue = opts.minPastDue ?? 0;
  const drafts: CollectionsDraft[] = [];

  for (const customer of parsed.customers) {
    const due = pastDue(customer.buckets);
    if (due <= 0 || due < minPastDue) continue;
    const rung = rungFor(customer.buckets);
    if (!rung) continue;
    const lines = overdueLines(customer);
    const dueDate = lines[0]?.dueDate ?? null;
    const emailContext: ChaseEmailContext = {
      companyName: ORG_DISPLAY_NAMES[orgCode] ?? orgCode,
      senderName: opts.sender?.senderName ?? "Accounts Receivable",
      ...(opts.sender?.senderContact
        ? { senderContact: opts.sender.senderContact }
        : {}),
    };
    const composed = buildChaseEmail(customer, rung, emailContext);
    drafts.push({
      orgCode,
      customerId: customer.customerId,
      customerName: customer.customerName,
      title: clampText(
        `Collections: ${customer.customerName} — ${money(due)} past due (${rung.label})`,
        3,
        200,
      ),
      description: describe(customer, rung, orgCode, parsed.agedOn),
      dueDate,
      idempotencyKey: `collections:${orgCode}:${parsed.agedOn ?? "unknown"}:${customer.customerId}`,
      step: rung.step,
      pastDue: due,
      email: {
        recipient: composed.to,
        blockedReason: composed.blockedReason,
        subject: composed.subject,
        body: composed.body,
      },
    });
  }
  return drafts;
}

/**
 * Record the composed chase text for a task, so the approver reviews rather
 * than retypes. Inert by construction: this is a plain INSERT of text into an
 * append-only table. It authorizes nothing and enqueues nothing — the Gmail
 * draft still requires the same two human steps against gmail_draft_previews.
 *
 * A failure here must never lose the governed issue: the issue is the thing
 * that matters, the prefill is a convenience. Callers treat this as best-effort.
 */
async function recordChaseProposal(
  operatingPool: DatabasePool,
  input: {
    organizationId: string;
    userId: string;
    taskId: string;
    customerId: string;
    customerName: string;
    recipient: string | null;
    blockedReason: string | null;
    subject: string;
    body: string;
    ladderStep: number;
    pastDue: number;
    agedOn: string | null;
  },
): Promise<void> {
  await withOrganizationScope(
    operatingPool,
    { userId: input.userId, organizationIds: [input.organizationId] },
    async (client) => {
      await client.query(
        `INSERT INTO collections_chase_proposals (
           id, organization_id, task_id, customer_id, customer_name,
           recipient, blocked_reason, subject, body, ladder_step, past_due, aged_on
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id, task_id) DO NOTHING`,
        [
          randomUUID(),
          input.organizationId,
          input.taskId,
          input.customerId,
          input.customerName,
          input.recipient,
          input.blockedReason,
          input.subject,
          input.body,
          input.ladderStep,
          input.pastDue,
          input.agedOn,
        ],
      );
    },
  );
}

export interface CollectionsSyncSkip {
  customerId: string;
  reason: string;
}

export interface CollectionsSyncResult {
  agedOn: string | null;
  orgCode: string | null;
  scanned: number;
  created: number;
  replayed: number;
  /** Chases whose draft text was recorded for prefill. */
  proposed: number;
  /** Chases with no AR email on file — raised, but a human must address them. */
  unaddressable: number;
  skipped: CollectionsSyncSkip[];
}

/**
 * Feed a parsed aging report through governed intake. One issue per past-due
 * customer, idempotent per customer + aging date. Mirrors the DemandStar
 * doorway's proven createManualIssue path.
 */
export async function syncArAging(
  operatingPool: DatabasePool,
  parsed: ParsedAging,
  config: CollectionsConfig,
  organizationIdsByCode: Record<string, string>,
  opts: { orgCode?: string } = {},
): Promise<CollectionsSyncResult> {
  const drafts = buildCollectionsDrafts(parsed, {
    ...(opts.orgCode ? { orgCode: opts.orgCode } : {}),
    minPastDue: config.minPastDue,
    sender: {
      senderName: config.senderName,
      ...(config.senderContact ? { senderContact: config.senderContact } : {}),
    },
  });
  const orgCode = drafts[0]?.orgCode ?? opts.orgCode ?? null;

  const result: CollectionsSyncResult = {
    agedOn: parsed.agedOn,
    orgCode,
    scanned: parsed.customers.length,
    created: 0,
    replayed: 0,
    proposed: 0,
    unaddressable: 0,
    skipped: [],
  };
  if (drafts.length === 0) return result;

  const principal = await resolveApplicationPrincipal(operatingPool, {
    issuer: "collections-bridge",
    subject: config.serviceUserEmail,
    email: config.serviceUserEmail,
  });

  for (const draft of drafts) {
    const organizationId = organizationIdsByCode[draft.orgCode];
    if (!organizationId) {
      result.skipped.push({
        customerId: draft.customerId,
        reason: `no organization for code ${draft.orgCode}`,
      });
      continue;
    }
    try {
      const response = await createManualIssue(operatingPool, {
        principal,
        input: {
          organizationId,
          title: draft.title,
          description: draft.description,
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
          retentionClassification: "operational",
        },
        idempotencyKey: draft.idempotencyKey,
        context: {
          traceId: `collections-${draft.idempotencyKey}`,
          requestId: `collections-${draft.orgCode}-${draft.customerId}`,
        },
      });
      if (response.duplicate) result.replayed += 1;
      else result.created += 1;

      // Record the composed chase text for prefill. Best-effort by design: the
      // governed issue is the deliverable, the prefill is a convenience, so a
      // failure here is reported but never fails the chase.
      if (draft.email.recipient === null) result.unaddressable += 1;
      try {
        await recordChaseProposal(operatingPool, {
          organizationId,
          userId: principal.userId,
          taskId: response.taskId,
          customerId: draft.customerId,
          customerName: draft.customerName,
          recipient: draft.email.recipient,
          blockedReason: draft.email.blockedReason,
          subject: draft.email.subject,
          body: draft.email.body,
          ladderStep: draft.step,
          pastDue: draft.pastDue,
          agedOn: parsed.agedOn,
        });
        result.proposed += 1;
      } catch (error) {
        result.skipped.push({
          customerId: draft.customerId,
          reason: `chase raised but draft text not recorded: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        });
      }
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "idempotency_key_conflict"
      ) {
        result.replayed += 1;
        continue;
      }
      result.skipped.push({
        customerId: draft.customerId,
        reason:
          error instanceof DomainError
            ? `${error.code}: ${error.message}`
            : "intake failed",
      });
    }
  }
  return result;
}
