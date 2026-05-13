// Canonical seed — identity + roster.
//
// Writes the canonical roster from DATA_MODEL_DECISION.md. Idempotent
// across re-runs.
//
// Run:  pnpm seed
//
// What this script does, in order:
//   1. Cleans up legacy demo Clerk users (emails ending
//      "+tractionos-seed@example.com"). Frees Clerk org seats.
//   2. Mirrors the 3 Clerk orgs into local `organizations`.
//   3. For each canonical person:
//        a. Locates Tim by his existing Clerk admin membership; creates or
//           finds everyone else by canonical email.
//        b. Adds Clerk per-org memberships per spec, gracefully logging
//           cap-rejections (Clerk free tier is ~5 members/org).
//        c. Upserts the local `people` row keyed on `clerk_user_id`. Updates
//           name/email to the canonical values when they drift.
//   4. Writes `org_memberships` rows in Postgres — the canonical roster
//      is **independent of Clerk**, so this lands every membership even
//      if Clerk rejected one. (DATA_MODEL_DECISION.md §3.)
//   5. Upserts measurables / rocks / issues with owners taken from the
//      canonical roster. Existing rows have their `owner_id` updated when
//      the slug-mapped person changed (e.g. Daniel Hale → Daniel
//      Milavickas).
//   6. Weeks + entries: re-runnable; never overwrites real data. Synthetic
//      seed values exist only to make /me look populated until real KPI
//      feeds land.
//   7. Cleanup: deletes orphan local `people` rows whose Clerk user no
//      longer exists AND who own nothing.

import { createClerkClient } from "@clerk/backend";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  organizations,
  people,
  orgMemberships,
  measurables,
  weeks,
  entries,
  rocks,
  issues,
} from "@/lib/db/schema";

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) {
  console.error("[seed] CLERK_SECRET_KEY missing in .env.local");
  process.exit(1);
}
const clerk = createClerkClient({ secretKey: SECRET });

// ── Specifications ─────────────────────────────────────────────────────────

const ORG_SPECS = [
  { slug: "fs", name: "Fastening Specialists" },
  { slug: "bl", name: "Big League Construction Supply" },
  { slug: "usa", name: "Utility Supply Associates" },
] as const;

type OrgSlug = (typeof ORG_SPECS)[number]["slug"];

type PersonSlug =
  | "tim"
  | "nick"
  | "cody"
  | "tyler"
  | "chip"
  | "craig"
  | "chris_booth"
  | "tom"
  | "daniel"
  | "chris_coghlan"
  | "mike"
  | "andrew"
  | "bill";

interface PersonSpec {
  slug: PersonSlug;
  name: string;
  email: string;
  /** Clerk per-org role per org. Tim is admin in all three; everyone else
   *  is a member. The "admin only Tim" rule (DATA_MODEL_DECISION.md). */
  memberships: { org: OrgSlug; role: "org:admin" | "org:member" }[];
  /** Locate Tim by his existing Clerk admin membership rather than creating
   *  a user. His Clerk email is whatever he signs in with. */
  locateOnly?: boolean;
}

// Canonical roster — DATA_MODEL_DECISION.md.
//
// Tim is admin in all three orgs (the "Tim Clark only" admin rule).
// USA wasn't in his roster snippet but admin coverage is required somewhere
// or /admin/readiness is locked out for USA.
//
// Cross-org members live once in PEOPLE_SPEC with multiple memberships.
// Slugs are stable identifiers used by MEASURABLES_SPEC / ROCKS_SPEC /
// ISSUES_SPEC to map ownership without baking in person UUIDs.
const PEOPLE_SPEC: PersonSpec[] = [
  {
    slug: "tim",
    name: "Tim Clark",
    email: "Tclark@bigleaguecs.com",
    memberships: [
      { org: "fs", role: "org:admin" },
      { org: "bl", role: "org:admin" },
      { org: "usa", role: "org:admin" },
    ],
    locateOnly: true,
  },
  // ─── Big League ────────────────────────────────────────────────────────
  {
    slug: "nick",
    name: "Nick Dorfmueller",
    email: "Nicholas.Dorfmueller@bigleaguecs.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  {
    slug: "cody",
    name: "Cody Braden",
    email: "Cody.braden@bigleaguecs.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  {
    slug: "tyler",
    name: "Tyler Shinn",
    email: "tyler.shinn@bigleaguecs.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  {
    slug: "chris_booth",
    name: "Chris Booth",
    email: "chris.booth@bigleaguecs.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  // ─── Fastening Specialists ─────────────────────────────────────────────
  {
    slug: "tom",
    name: "Tom Fowler",
    email: "t.fowler@fasteningspecialists.com",
    memberships: [{ org: "fs", role: "org:member" }],
  },
  {
    slug: "daniel",
    name: "Daniel Milavickas",
    email: "d.milavickas@fasteningspecialists.com",
    memberships: [{ org: "fs", role: "org:member" }],
  },
  // ─── Cross-org ─────────────────────────────────────────────────────────
  {
    slug: "chip",
    name: "Chip Bridges",
    email: "c.bridges@fasteningspecialists.com",
    memberships: [
      { org: "fs", role: "org:member" },
      { org: "bl", role: "org:member" },
    ],
  },
  {
    slug: "craig",
    name: "Craig Zahner",
    email: "Craig.Zahner@bigleaguecs.com",
    memberships: [
      { org: "fs", role: "org:member" },
      { org: "bl", role: "org:member" },
    ],
  },
  {
    slug: "chris_coghlan",
    name: "Chris Coghlan",
    email: "chris.coghlan@bigleaguecs.com",
    memberships: [
      { org: "fs", role: "org:member" },
      { org: "usa", role: "org:member" },
    ],
  },
  // ─── USA ───────────────────────────────────────────────────────────────
  {
    slug: "mike",
    name: "Mike Grant",
    email: "m.grant@fasteningspecialists.com",
    memberships: [{ org: "usa", role: "org:member" }],
  },
  {
    slug: "andrew",
    name: "Andrew Sutt",
    email: "andrew@utilitysupplyassociates.com",
    memberships: [{ org: "usa", role: "org:member" }],
  },
  {
    slug: "bill",
    name: "Bill Potts",
    email: "bill@utilitysupplyassociates.com",
    memberships: [{ org: "usa", role: "org:member" }],
  },
];

type GoalDirection = "gte" | "lte" | "eq" | "between" | "trend_down" | "trend_up";

interface MeasurableSpec {
  org: OrgSlug;
  name: string;
  owner: PersonSlug;
  unit: string;
  formatHint: string;
  goalDirection: GoalDirection;
  goalValue: number | null;
  cadence: "weekly" | "monthly";
  formula?: string;
}

// Per docs/kpi-definitions.md §"Per-entity replication". Owners use the new
// roster slugs; on re-run the seed updates measurables.owner_id to match.
//
// Spreadsheet bootstrap (real KPIs, owners, targets, weekly history) lands
// in a separate slice; this is placeholder structure to keep /me + the
// scorecard populated.
const MEASURABLES_SPEC: MeasurableSpec[] = [
  // ─── FS ──────────────────────────────────────────────────────────────────
  { org: "fs", name: "Revenue (Weekly)", owner: "daniel", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Net sales per entity per week" },
  { org: "fs", name: "Gross Profit %", owner: "daniel", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.50, cadence: "weekly", formula: "(Revenue – (COGS + Freight Burden)) / Revenue" },
  { org: "fs", name: "DSO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", formula: "AR / (Revenue / 365)" },
  { org: "fs", name: "DPO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", formula: "AP / (COGS / 365)" },
  { org: "fs", name: "DIO", owner: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", formula: "Inventory / (COGS / 365)" },
  { org: "fs", name: "Inventory Turns", owner: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", formula: "COGS / Avg Inventory" },
  { org: "fs", name: "Fill Rate %", owner: "tom", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.95, cadence: "weekly", formula: "Lines Shipped Complete / Total Lines Ordered" },
  { org: "fs", name: "AR Collections ($)", owner: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Cash collected on AR for the week" },
  { org: "fs", name: "Open Orders (Backlog)", owner: "chip", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_down", goalValue: null, cadence: "weekly", formula: "Total open SO value (declining trend)" },
  { org: "fs", name: "New Accounts Opened", owner: "daniel", unit: "count", formatHint: "count", goalDirection: "gte", goalValue: 1, cadence: "weekly", formula: "New customer accounts opened this week" },
  { org: "fs", name: "On-Time Deliveries", owner: "chip", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.85, cadence: "weekly", formula: "Deliveries on or before promise date" },

  // ─── BL ──────────────────────────────────────────────────────────────────
  { org: "bl", name: "Revenue (Weekly)", owner: "nick", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 100_000, cadence: "weekly", formula: "Net sales per entity per week" },
  { org: "bl", name: "Gross Profit %", owner: "nick", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.30, cadence: "weekly", formula: "(Revenue – (COGS + Freight Burden)) / Revenue" },
  { org: "bl", name: "DSO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", formula: "AR / (Revenue / 365)" },
  { org: "bl", name: "DPO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", formula: "AP / (COGS / 365)" },
  { org: "bl", name: "DIO", owner: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", formula: "Inventory / (COGS / 365)" },
  { org: "bl", name: "Inventory Turns", owner: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", formula: "COGS / Avg Inventory" },
  { org: "bl", name: "Fill Rate %", owner: "chris_booth", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.95, cadence: "weekly", formula: "Lines Shipped Complete / Total Lines Ordered" },
  { org: "bl", name: "AR Collections ($)", owner: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Cash collected on AR for the week" },
  { org: "bl", name: "Open Orders (Backlog)", owner: "chip", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_down", goalValue: null, cadence: "weekly", formula: "Total open SO value (declining trend)" },
  { org: "bl", name: "New Accounts Opened", owner: "nick", unit: "count", formatHint: "count", goalDirection: "gte", goalValue: 1, cadence: "weekly", formula: "New customer accounts opened this week" },
  { org: "bl", name: "On-Time Deliveries", owner: "chip", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.85, cadence: "weekly", formula: "Deliveries on or before promise date" },

  // ─── USA ─────────────────────────────────────────────────────────────────
  { org: "usa", name: "Revenue (Weekly)", owner: "andrew", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 312_000, cadence: "weekly", formula: "Net sales per entity per week" },
  { org: "usa", name: "Gross Profit %", owner: "andrew", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.15, cadence: "weekly", formula: "(Revenue – (COGS + Freight Burden)) / Revenue" },
  { org: "usa", name: "DSO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 45, cadence: "weekly", formula: "AR / (Revenue / 365)" },
  { org: "usa", name: "DPO", owner: "tim", unit: "days", formatHint: "days", goalDirection: "gte", goalValue: 30, cadence: "weekly", formula: "AP / (COGS / 365)" },
  { org: "usa", name: "DIO", owner: "craig", unit: "days", formatHint: "days", goalDirection: "lte", goalValue: 60, cadence: "weekly", formula: "Inventory / (COGS / 365)" },
  { org: "usa", name: "Inventory Turns", owner: "craig", unit: "x", formatHint: "turns", goalDirection: "gte", goalValue: 6, cadence: "monthly", formula: "COGS / Avg Inventory" },
  { org: "usa", name: "AR Collections ($)", owner: "tim", unit: "USD", formatHint: "currency_usd", goalDirection: "gte", goalValue: 250_000, cadence: "weekly", formula: "Cash collected on AR for the week" },
  { org: "usa", name: "Open Orders (Backlog)", owner: "chip", unit: "USD", formatHint: "currency_usd_trend", goalDirection: "trend_down", goalValue: null, cadence: "weekly", formula: "Total open SO value (declining trend)" },
];

interface RockSpec {
  org: OrgSlug;
  description: string;
  owner: PersonSlug;
  status: "on_track" | "off_track" | "completed";
  notes?: string;
}

const ROCKS_SPEC: RockSpec[] = [
  { org: "fs", description: "Implement Acumatica inventory module", owner: "craig", status: "off_track", notes: "Vendor proposal still in flight; sandbox not stood up." },
  { org: "fs", description: "Fix labeling process and train team", owner: "daniel", status: "on_track", notes: "Training videos in progress; scorecard pending." },
  { org: "fs", description: "Reduce DSO to ≤35 days", owner: "tim", status: "on_track" },
  { org: "fs", description: "CRM build-out completion for FS", owner: "daniel", status: "on_track", notes: "Completion = standards/scoreboard & KPIs dashboard visible." },
  { org: "usa", description: "Onboard logistics partner(s)", owner: "mike", status: "on_track" },
  { org: "bl", description: "Update company SOPs", owner: "nick", status: "on_track" },
  { org: "usa", description: "Move USA to Acumatica", owner: "tim", status: "on_track", notes: "Performing data migration for switch to Premium." },
  { org: "bl", description: "Complete COA migration to new structure", owner: "tim", status: "on_track" },
  { org: "fs", description: "Company AI Module v1.0", owner: "tim", status: "on_track" },
];

interface IssueSpec {
  org: OrgSlug;
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  owner: PersonSlug;
  rootCause?: string;
}

const ISSUES_SPEC: IssueSpec[] = [
  { org: "fs", title: "Fill rate at 95% is unachievable with current safety stock min/max", priority: "high", owner: "tom", rootCause: "Safety stock policy doesn't support 95% — fill rate is too expensive at this min/max." },
  { org: "fs", title: "Need to know when special orders are received", priority: "high", owner: "chip", rootCause: "No flag in Acumatica when receipt hits the dock." },
  { org: "fs", title: "Dead stock report parameters and cadence", priority: "medium", owner: "craig" },
  { org: "bl", title: "Premature invoices", priority: "critical", owner: "tim", rootCause: "Invoices going out before delivery confirmation." },
  { org: "bl", title: "How do we reduce cycle time on receiving?", priority: "medium", owner: "chip" },
  { org: "usa", title: "Quote → product-on-ground (POD) scoreboard", priority: "medium", owner: "andrew", rootCause: "No visibility on the receive-to-deliver cycle for USA waterworks." },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_EMAIL_PATTERN = "+tractionos-seed@example.com";

/** Last 3 Friday week-endings, in chronological order (oldest first). */
function lastThreeFridays(today: Date): Date[] {
  const result: Date[] = [];
  const d = new Date(today);
  const dow = d.getDay();
  const offsetToLastFriday = (dow + 2) % 7; // 0 if Friday, 1 if Saturday, …
  d.setDate(d.getDate() - offsetToLastFriday);
  for (let i = 0; i < 3; i++) {
    const copy = new Date(d);
    copy.setDate(d.getDate() - i * 7);
    result.unshift(copy);
  }
  return result;
}

function isoWeek(d: Date): { weekNumber: number; year: number } {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNumber =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return { weekNumber, year: target.getUTCFullYear() };
}

function quarterLabel(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${d.getFullYear()}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function plausibleActual(
  spec: MeasurableSpec,
  weekIdx: number,
  variance: number,
): number {
  const noise = (variance - 0.5) * 0.04;
  if (spec.goalDirection === "gte" && spec.goalValue !== null) {
    const offset = 0.15 - weekIdx * 0.06 + noise;
    return round(spec.goalValue * (1 - offset), spec);
  }
  if (spec.goalDirection === "lte" && spec.goalValue !== null) {
    const offset = 0.18 - weekIdx * 0.07 + noise;
    return round(spec.goalValue * (1 + offset), spec);
  }
  if (spec.goalDirection === "eq" && spec.goalValue !== null) {
    return round(spec.goalValue * (1 + (variance - 0.5) * 0.06), spec);
  }
  if (spec.goalDirection === "trend_down") {
    return round(1_500_000 - weekIdx * 90_000 + variance * 50_000, spec);
  }
  return round(0, spec);
}

function round(n: number, spec: MeasurableSpec): number {
  if (spec.formatHint === "percent") return Math.round(n * 10_000) / 10_000;
  if (spec.formatHint === "currency_usd" || spec.formatHint === "currency_usd_trend")
    return Math.round(n);
  if (spec.formatHint === "days") return Math.round(n * 10) / 10;
  if (spec.formatHint === "turns") return Math.round(n * 100) / 100;
  return Math.round(n);
}

async function findOrgBySlug(slug: string) {
  const list = await clerk.organizations.getOrganizationList({ limit: 200 });
  const found = list.data.find((o) => o.slug === slug);
  if (!found) throw new Error(`Clerk org with slug "${slug}" not found`);
  return found;
}

async function findExistingTim(fsOrgId: string): Promise<string> {
  const memberships = await clerk.organizations.getOrganizationMembershipList({
    organizationId: fsOrgId,
    limit: 200,
  });
  const admin = memberships.data.find((m) => m.role === "org:admin");
  if (!admin?.publicUserData?.userId)
    throw new Error(`No admin found on FS org ${fsOrgId}. Run setup:clerk-admin first.`);
  return admin.publicUserData.userId;
}

async function findOrCreateClerkUser(spec: PersonSpec): Promise<string> {
  const existing = await clerk.users.getUserList({
    emailAddress: [spec.email],
    limit: 1,
  });
  if (existing.data[0]) return existing.data[0].id;

  const [firstName, ...rest] = spec.name.split(" ");
  const lastName = rest.join(" ");
  const user = await clerk.users.createUser({
    emailAddress: [spec.email],
    firstName,
    lastName,
    skipPasswordRequirement: true,
  });
  return user.id;
}

/** Best-effort: add membership; on per-org cap rejection, log + continue
 *  so the seed converges regardless of Clerk's free-tier seat limit. */
async function ensureMembershipBestEffort(
  orgId: string,
  userId: string,
  role: "org:admin" | "org:member",
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const list = await clerk.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 200,
    });
    const found = list.data.find((m) => m.publicUserData?.userId === userId);
    if (found) {
      if (found.role !== role) {
        await clerk.organizations.updateOrganizationMembership({
          organizationId: orgId,
          userId,
          role,
        });
      }
      return { ok: true };
    }
    await clerk.organizations.createOrganizationMembership({
      organizationId: orgId,
      userId,
      role,
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

async function pruneClerkMemberships(
  userId: string,
  keepOrgIds: Set<string>,
  orgClerkIds: string[],
) {
  for (const orgId of orgClerkIds) {
    if (keepOrgIds.has(orgId)) continue;
    const list = await clerk.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 200,
    });
    const found = list.data.find((m) => m.publicUserData?.userId === userId);
    if (!found) continue;
    await clerk.organizations.deleteOrganizationMembership({
      organizationId: orgId,
      userId,
    });
  }
}

/** Step 1: delete legacy demo Clerk users so their seats are freed before
 *  we attempt to add the canonical roster. Identified by the
 *  +tractionos-seed@example.com email pattern. */
async function cleanupLegacyClerkUsers(): Promise<number> {
  let deleted = 0;
  let offset = 0;
  const PAGE = 200;
  while (true) {
    const list = await clerk.users.getUserList({ limit: PAGE, offset });
    if (list.data.length === 0) break;
    for (const u of list.data) {
      const isLegacy = u.emailAddresses.some((e) =>
        e.emailAddress.includes(FAKE_EMAIL_PATTERN),
      );
      if (!isLegacy) continue;
      try {
        await clerk.users.deleteUser(u.id);
        deleted++;
        console.log(
          `[seed] cleanup: deleted legacy clerk user ${u.id} (${u.emailAddresses[0]?.emailAddress ?? "?"})`,
        );
      } catch (err) {
        console.warn(
          `[seed] cleanup: failed to delete clerk user ${u.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (list.data.length < PAGE) break;
    offset += PAGE;
  }
  return deleted;
}

/** Final cleanup: remove local people rows whose Clerk user is gone AND
 *  who own nothing. Safe — preserves anyone with FK references. */
async function cleanupOrphanPeople(validClerkUserIds: Set<string>): Promise<number> {
  const allPeople = await db.select().from(people);
  let deleted = 0;
  for (const p of allPeople) {
    if (validClerkUserIds.has(p.clerkUserId)) continue;
    const owns = await db
      .select({
        m: sql<number>`count(${measurables.id})`.as("m"),
      })
      .from(measurables)
      .where(eq(measurables.ownerId, p.id));
    const ownsM = Number(owns[0]?.m ?? 0);
    const ownsR = await db
      .select({ c: sql<number>`count(${rocks.id})`.as("c") })
      .from(rocks)
      .where(eq(rocks.ownerId, p.id));
    const ownsRn = Number(ownsR[0]?.c ?? 0);
    const ownsI = await db
      .select({ c: sql<number>`count(${issues.id})`.as("c") })
      .from(issues)
      .where(eq(issues.ownerId, p.id));
    const ownsIn = Number(ownsI[0]?.c ?? 0);
    if (ownsM > 0 || ownsRn > 0 || ownsIn > 0) continue;

    // Also clear any stray org_memberships first (FK).
    await db.delete(orgMemberships).where(eq(orgMemberships.personId, p.id));
    // Clear default_org_id self-references (none point at people, but be safe
    // for any future FK additions). Then delete.
    await db.delete(people).where(eq(people.id, p.id));
    deleted++;
    console.log(
      `[seed] cleanup: deleted orphan local person ${p.name} (${p.email})`,
    );
  }
  return deleted;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // 0) Cleanup legacy demo Clerk users so seats are freed before we add real ones.
  const legacyDeleted = await cleanupLegacyClerkUsers();
  console.log(`[seed] legacy cleanup: ${legacyDeleted} clerk users deleted`);

  // 1) Orgs
  const orgIdBySlug: Record<OrgSlug, string> = {} as Record<OrgSlug, string>;
  const orgClerkIdBySlug: Record<OrgSlug, string> = {} as Record<OrgSlug, string>;
  for (const o of ORG_SPECS) {
    const clerkOrg = await findOrgBySlug(o.slug);
    orgClerkIdBySlug[o.slug] = clerkOrg.id;
    const existing = await db
      .select()
      .from(organizations)
      .where(eq(organizations.clerkOrgId, clerkOrg.id))
      .limit(1);
    if (existing[0]) {
      orgIdBySlug[o.slug] = existing[0].id;
    } else {
      const inserted = await db
        .insert(organizations)
        .values({ clerkOrgId: clerkOrg.id, name: o.name, code: o.slug.toUpperCase() })
        .returning({ id: organizations.id });
      orgIdBySlug[o.slug] = inserted[0]!.id;
    }
    console.log(`[seed] org  ${o.slug.padEnd(4)} ${clerkOrg.id}`);
  }

  // 2) People — Clerk user + Clerk membership (best-effort) + local row.
  const personIdBySlug: Record<PersonSlug, string> = {} as Record<PersonSlug, string>;
  const validClerkUserIds = new Set<string>();
  const fsClerkOrgId = orgClerkIdBySlug.fs;
  const allOrgClerkIds = ORG_SPECS.map((o) => orgClerkIdBySlug[o.slug]);

  const clerkSkipped: { person: string; org: OrgSlug; reason: string }[] = [];

  for (const p of PEOPLE_SPEC) {
    const clerkUserId = p.locateOnly
      ? await findExistingTim(fsClerkOrgId)
      : await findOrCreateClerkUser(p);
    validClerkUserIds.add(clerkUserId);

    const wantOrgClerkIds = new Set(p.memberships.map((m) => orgClerkIdBySlug[m.org]));
    await pruneClerkMemberships(clerkUserId, wantOrgClerkIds, allOrgClerkIds);

    for (const m of p.memberships) {
      const orgClerkId = orgClerkIdBySlug[m.org];
      const result = await ensureMembershipBestEffort(orgClerkId, clerkUserId, m.role);
      if (!result.ok) {
        clerkSkipped.push({ person: p.name, org: m.org, reason: result.reason ?? "?" });
      }
    }

    // Upsert local people row keyed on clerk_user_id. Update name + email
    // when they drift from the canonical spec.
    const existing = await db
      .select()
      .from(people)
      .where(eq(people.clerkUserId, clerkUserId))
      .limit(1);
    if (existing[0]) {
      personIdBySlug[p.slug] = existing[0].id;
      const drifted =
        existing[0].name !== p.name || existing[0].email !== p.email;
      const wantRole = p.slug === "tim" ? "admin" : "member";
      const roleDrifted = existing[0].role !== wantRole;
      if (drifted || roleDrifted) {
        await db
          .update(people)
          .set({
            name: p.name,
            email: p.email,
            role: wantRole,
          })
          .where(eq(people.id, existing[0].id));
      }
    } else {
      const defaultOrgSlug = p.memberships[0]?.org;
      if (!defaultOrgSlug) throw new Error(`${p.slug} has no memberships`);
      const inserted = await db
        .insert(people)
        .values({
          clerkUserId,
          name: p.name,
          email: p.email,
          defaultOrgId: orgIdBySlug[defaultOrgSlug],
          role: p.slug === "tim" ? "admin" : "member",
        })
        .returning({ id: people.id });
      personIdBySlug[p.slug] = inserted[0]!.id;
    }
    console.log(`[seed] user ${p.slug.padEnd(14)} ${clerkUserId}`);
  }

  if (clerkSkipped.length > 0) {
    console.log(
      `[seed] note: ${clerkSkipped.length} clerk membership(s) were not added (free-tier cap or other):`,
    );
    for (const s of clerkSkipped) {
      console.log(`        - ${s.person} → ${s.org}: ${s.reason}`);
    }
    console.log(
      `        Postgres org_memberships still reflect the canonical roster.`,
    );
  }

  // 3) Org memberships (Postgres canonical roster).
  let omInserts = 0;
  let omUpdates = 0;
  for (const p of PEOPLE_SPEC) {
    for (const m of p.memberships) {
      const orgId = orgIdBySlug[m.org];
      const personId = personIdBySlug[p.slug];
      const role: "admin" | "member" = m.role === "org:admin" ? "admin" : "member";
      const existing = await db
        .select()
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.orgId, orgId),
            eq(orgMemberships.personId, personId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].role !== role) {
          await db
            .update(orgMemberships)
            .set({ role })
            .where(eq(orgMemberships.id, existing[0].id));
          omUpdates++;
        }
      } else {
        await db.insert(orgMemberships).values({ orgId, personId, role });
        omInserts++;
      }
    }
  }
  console.log(
    `[seed] org_memberships: ${omInserts} inserted, ${omUpdates} updated`,
  );

  // 4) Measurables — upsert by (orgId, name); update owner_id when changed.
  const measurableIdByKey: Record<string, string> = {};
  let mInserts = 0;
  let mOwnerUpdates = 0;
  let mIdx = 0;
  for (const m of MEASURABLES_SPEC) {
    const orgId = orgIdBySlug[m.org];
    const targetOwnerId = personIdBySlug[m.owner];
    const existing = await db
      .select()
      .from(measurables)
      .where(and(eq(measurables.orgId, orgId), eq(measurables.name, m.name)))
      .limit(1);
    let id: string;
    if (existing[0]) {
      id = existing[0].id;
      if (existing[0].ownerId !== targetOwnerId) {
        await db
          .update(measurables)
          .set({ ownerId: targetOwnerId })
          .where(eq(measurables.id, existing[0].id));
        mOwnerUpdates++;
      }
    } else {
      const inserted = await db
        .insert(measurables)
        .values({
          orgId,
          name: m.name,
          ownerId: targetOwnerId,
          unit: m.unit,
          formatHint: m.formatHint,
          goalDirection: m.goalDirection,
          goalValue: m.goalValue !== null ? String(m.goalValue) : null,
          cadence: m.cadence,
          formula: m.formula,
          displayOrder: mIdx * 10,
        })
        .returning({ id: measurables.id });
      id = inserted[0]!.id;
      mInserts++;
    }
    measurableIdByKey[`${m.org}:${m.name}`] = id;
    mIdx++;
  }
  console.log(
    `[seed] measurables: ${mInserts} inserted, ${mOwnerUpdates} owner-reassigned`,
  );

  // 5) Weeks — last 3 Fridays (placeholder until real meeting cadence lands).
  const weekDates = lastThreeFridays(new Date());
  const weekIdByDate: Record<string, string> = {};
  for (const d of weekDates) {
    const dateStr = ymd(d);
    const existing = await db
      .select()
      .from(weeks)
      .where(eq(weeks.weekEndingDate, dateStr))
      .limit(1);
    if (existing[0]) {
      weekIdByDate[dateStr] = existing[0].id;
    } else {
      const iw = isoWeek(d);
      const inserted = await db
        .insert(weeks)
        .values({
          weekEndingDate: dateStr,
          weekNumber: iw.weekNumber,
          quarter: quarterLabel(d),
          fiscalYear: iw.year,
        })
        .returning({ id: weeks.id });
      weekIdByDate[dateStr] = inserted[0]!.id;
    }
  }
  console.log(`[seed] weeks: ${Object.keys(weekIdByDate).length}`);

  // 6) Entries — synthetic seed values; never overwrites.
  let eCount = 0;
  for (const m of MEASURABLES_SPEC) {
    const variance = ((m.org.charCodeAt(0) + m.name.length) % 100) / 100;
    const measurableId = measurableIdByKey[`${m.org}:${m.name}`];
    if (!measurableId) continue;
    for (let i = 0; i < weekDates.length; i++) {
      const d = weekDates[i]!;
      const weekId = weekIdByDate[ymd(d)];
      if (!weekId) continue;
      const existing = await db
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(eq(entries.measurableId, measurableId), eq(entries.weekId, weekId)),
        )
        .limit(1);
      if (existing[0]) continue;
      const actual = plausibleActual(m, i, variance);
      await db.insert(entries).values({
        measurableId,
        weekId,
        actual: String(actual),
        source: "system",
      });
      eCount++;
    }
  }
  console.log(`[seed] entries inserted: ${eCount} (skipped existing)`);

  // 7) Rocks — upsert by (orgId, description, quarter); update owner.
  const q2_2026 = "Q2 2026";
  const q2End = "2026-06-30";
  let rInserts = 0;
  let rOwnerUpdates = 0;
  for (const r of ROCKS_SPEC) {
    const targetOwnerId = personIdBySlug[r.owner];
    const existing = await db
      .select()
      .from(rocks)
      .where(
        and(
          eq(rocks.orgId, orgIdBySlug[r.org]),
          eq(rocks.description, r.description),
          eq(rocks.quarter, q2_2026),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].ownerId !== targetOwnerId) {
        await db
          .update(rocks)
          .set({ ownerId: targetOwnerId })
          .where(eq(rocks.id, existing[0].id));
        rOwnerUpdates++;
      }
    } else {
      await db.insert(rocks).values({
        orgId: orgIdBySlug[r.org],
        description: r.description,
        ownerId: targetOwnerId,
        quarter: q2_2026,
        dueDate: q2End,
        status: r.status,
        notes: r.notes,
      });
      rInserts++;
    }
  }
  console.log(
    `[seed] rocks: ${rInserts} inserted, ${rOwnerUpdates} owner-reassigned`,
  );

  // 8) Issues — upsert by (orgId, title); update owner.
  let iInserts = 0;
  let iOwnerUpdates = 0;
  for (const i of ISSUES_SPEC) {
    const targetOwnerId = personIdBySlug[i.owner];
    const existing = await db
      .select()
      .from(issues)
      .where(
        and(eq(issues.orgId, orgIdBySlug[i.org]), eq(issues.title, i.title)),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].ownerId !== targetOwnerId) {
        await db
          .update(issues)
          .set({ ownerId: targetOwnerId })
          .where(eq(issues.id, existing[0].id));
        iOwnerUpdates++;
      }
    } else {
      await db.insert(issues).values({
        orgId: orgIdBySlug[i.org],
        title: i.title,
        priority: i.priority,
        ownerId: targetOwnerId,
        rootCause: i.rootCause,
        status: "open",
      });
      iInserts++;
    }
  }
  console.log(
    `[seed] issues: ${iInserts} inserted, ${iOwnerUpdates} owner-reassigned`,
  );

  // 9) Cleanup orphan local people rows whose Clerk user is gone AND who
  //    own nothing. Preserves any row with FK references intact.
  const orphansDeleted = await cleanupOrphanPeople(validClerkUserIds);
  console.log(`[seed] orphan cleanup: ${orphansDeleted} local people row(s) deleted`);

  console.log("[seed] done.");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
