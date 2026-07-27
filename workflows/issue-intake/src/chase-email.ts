import { usableRecipient } from "@operating-layer/connectors";
import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import { pastDue, type AgingCustomer } from "./ar-aging.js";
import { DEFAULT_LADDER, type LadderRung } from "./ar-collections.js";
import {
  requireOrganizationPermission,
  type ApplicationPrincipal,
} from "./identity.js";

/**
 * Deterministic chase-email composition.
 *
 * This is the piece that turns a collections issue from a to-do line ("chase
 * Acme") into a ready-to-review draft. It is a PURE function of the aging data
 * and the ladder rung — no model writes the email, so the numbers, the invoice
 * list, and the tone-per-rung are all reproducible and reviewable.
 *
 * Governance is unchanged by this file. Nothing here sends, enqueues, or
 * authorizes anything: it only proposes text that a human then previews and
 * authorizes through the existing two-step Gmail-draft path. The proposal
 * exists to remove retyping, not to remove the human.
 *
 * Tone ladder (from DEFAULT_LADDER, which stays the single source of the rung):
 *   1  friendly reminder   2  firm follow-up
 *   3  final notice        4  escalation
 */

export interface ChaseEmailProposal {
  /** Customer AR contact; null when Acumatica has no email on file. */
  to: string | null;
  subject: string;
  body: string;
  /** Why this could not be addressed, when `to` is null. */
  blockedReason: string | null;
}

export interface ChaseEmailContext {
  /** The chasing entity's display name, e.g. "Fastening Specialists". */
  companyName: string;
  /** Who signs the email — the AR person's display name. */
  senderName: string;
  /** Optional reply-to / phone line shown in the sign-off. */
  senderContact?: string;
}

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Opening line per rung: the escalation in tone lives here, as data. */
const OPENING: Record<number, (customerName: string) => string> = {
  1: (n) =>
    `Hi ${n},\n\nA quick reminder on the invoices below, which are now past due. If these are already scheduled or have crossed with a payment, please disregard.`,
  2: (n) =>
    `Hi ${n},\n\nFollowing up on the past-due invoices below. We haven't received payment yet, and I'd like to get these cleared up.`,
  3: (n) =>
    `Hi ${n},\n\nThis is a final notice on the past-due invoices below. These are significantly overdue and we need to resolve them.`,
  4: (n) =>
    `Hi ${n},\n\nThe invoices below are seriously past due and this account now requires immediate attention.`,
};

/** Closing ask per rung: escalates from soft to a firm requirement. */
const CLOSING: Record<number, string> = {
  1: "Could you confirm when we can expect payment? Happy to resend any invoice copies you need.",
  2: "Could you reply with a specific payment date? If something is disputed or missing paperwork, let me know and I'll get it sorted right away.",
  3: "Please reply with a payment date, or let me know directly if this is a dispute rather than a delay. I'd like to resolve this without escalating further.",
  4: "Please contact me today to arrange payment. Until this balance is resolved we may need to place new orders on hold.",
};

/** Overdue lines only, oldest due date first — the itemization a customer needs. */
function overdueLines(customer: AgingCustomer) {
  return customer.lines
    .filter((line) => pastDue(line.buckets) !== 0)
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

/**
 * Compose the chase email for one customer at one ladder rung.
 *
 * Returns a proposal even when there is no address on file — the caller keeps
 * the governed issue either way, and simply cannot pre-address the draft. That
 * is deliberate: a missing email should surface as a visible gap for a human,
 * never as a silently guessed recipient.
 */
export function buildChaseEmail(
  customer: AgingCustomer,
  rung: LadderRung,
  context: ChaseEmailContext,
): ChaseEmailProposal {
  const due = pastDue(customer.buckets);
  const lines = overdueLines(customer);
  const step = rung.step;

  const subject =
    step >= 3
      ? `${step === 4 ? "URGENT" : "Final notice"}: past-due balance ${money(due)} — ${context.companyName}`
      : `Past-due balance ${money(due)} — ${context.companyName}`;

  const itemized =
    lines.length > 0
      ? [
          "",
          "Past-due invoices:",
          ...lines.map(
            (l) =>
              `  ${l.refNbr}   due ${l.dueDate ?? "n/a"}   ${money(l.buckets.balance)}`,
          ),
          "",
          `  Total past due: ${money(due)}`,
        ]
      : ["", `  Total past due: ${money(due)}`];

  const body = [
    OPENING[step]!(customer.customerName),
    ...itemized,
    "",
    CLOSING[step]!,
    "",
    "Thank you,",
    context.senderName,
    context.companyName,
    ...(context.senderContact ? [context.senderContact] : []),
  ].join("\n");

  // Use the shared rule, not a looser local one: an address the database CHECK
  // would reject must fall through to blockedReason here, or the failed INSERT
  // throws away the drafted body as well — losing the prefill entirely for
  // exactly the customers this fallback exists to serve.
  const to = usableRecipient(customer.email);

  return {
    to,
    subject,
    body,
    blockedReason: to
      ? null
      : customer.email?.trim()
        ? // bounded: the stored column caps at 500 chars, and this echoes ERP data
          `AR contact email on file is not a usable address ("${customer.email
            .trim()
            .slice(0, 200)}")`
        : "no AR contact email on file in Acumatica for this customer",
  };
}

/** A `date` column as YYYY-MM-DD, without shifting it across a timezone. */
export function formatDateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return null;
}

export interface StoredChaseProposal {
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
}

/**
 * Read the recorded chase text for a task, so the approver's draft form can be
 * prefilled instead of retyped. Read-only and org-scoped: RLS plus the same
 * `tasks.read` permission that gates seeing the task at all.
 *
 * Returns null when there is no proposal (any non-collections task), which the
 * caller renders as today's empty form — the prefill is additive, never a
 * precondition for using the Gmail draft path.
 */
export async function getChaseProposal(
  pool: DatabasePool,
  principal: ApplicationPrincipal,
  organizationId: string,
  taskId: string,
): Promise<StoredChaseProposal | null> {
  requireOrganizationPermission(principal, organizationId, "tasks.read");

  return withOrganizationScope(
    pool,
    { userId: principal.userId, organizationIds: [organizationId] },
    async (client) => {
      const result = await client.query(
        `SELECT task_id, customer_id, customer_name, recipient, blocked_reason,
                subject, body, ladder_step, past_due, aged_on
           FROM collections_chase_proposals
          WHERE task_id = $1 AND organization_id = $2`,
        [taskId, organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        taskId: String(row.task_id),
        customerId: String(row.customer_id),
        customerName: String(row.customer_name),
        recipient: row.recipient === null ? null : String(row.recipient),
        blockedReason:
          row.blocked_reason === null ? null : String(row.blocked_reason),
        subject: String(row.subject),
        body: String(row.body),
        ladderStep: Number(row.ladder_step),
        pastDue: Number(row.past_due),
        // node-postgres materializes a `date` at LOCAL midnight, so
        // round-tripping through toISOString() reports the previous day in any
        // timezone east of UTC. Format from the local parts instead.
        agedOn: formatDateOnly(row.aged_on),
      };
    },
  );
}

/** Convenience: pick the rung from the customer's own aging, then compose. */
export function buildChaseEmailForCustomer(
  customer: AgingCustomer,
  context: ChaseEmailContext,
  ladder: Record<string, LadderRung> = DEFAULT_LADDER,
): ChaseEmailProposal | null {
  const buckets = customer.buckets;
  const worst =
    buckets.over90 > 0
      ? "over90"
      : buckets.d61_90 > 0
        ? "d61_90"
        : buckets.d31_60 > 0
          ? "d31_60"
          : buckets.d1_30 > 0
            ? "d1_30"
            : null;
  if (!worst) return null;
  const rung = ladder[worst];
  if (!rung) return null;
  return buildChaseEmail(customer, rung, context);
}
