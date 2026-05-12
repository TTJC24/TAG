// Seed script for Phase 1 step 10 / ADR-0009.
//
// Run:  pnpm seed
//
// Idempotent across all stages:
//   1. mirror the 3 Clerk orgs into the local organizations table
//   2. find Tim from Clerk admin membership; create/find the 8 other users
//   3. add memberships per ADR-0009 (Tim/Craig/Chip in all three; Daniel/Tom
//      in FS; Nick/ChrisB in BL; Andrew in USA; Mike in all three)
//   4. mirror people into local people table
//   5. measurables: 11 FS + 11 BL + 8 USA = 30 rows
//   6. weeks: last 3 Friday-ending weeks
//   7. entries: plausible actuals across the matrix, mostly trending toward goal
//   8. rocks: 9 quarterly priorities for Q2 2026
//   9. issues: starting parking-lot list (~6)
//
// Side effects on Clerk: creates up to 8 users with +tractionos-seed@example.com
// addresses and adds memberships. Re-runs skip anything that already exists.

import { createClerkClient } from "@clerk/backend";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  organizations,
  people,
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
  | "daniel"
  | "nick"
  | "andrew"
  | "craig"
  | "tom"
  | "chip"
  | "chrisb"
  | "mike";

interface PersonSpec {
  slug: PersonSlug;
  name: string;
  email: string;
  /** Clerk org:* role per org. tim is admin in all three; the rest member. */
  memberships: { org: OrgSlug; role: "org:admin" | "org:member" }[];
  /** Locate Tim by his existing membership rather than creating a user. */
  locateOnly?: boolean;
}

const PEOPLE_SPEC: PersonSpec[] = [
  // Tim already has a Clerk user (signed in to the dashboard); locate, don't create.
  {
    slug: "tim",
    name: "Tim Clark",
    email: "tim@bigleaguecs.com",
    memberships: [
      { org: "fs", role: "org:admin" },
      { org: "bl", role: "org:admin" },
      { org: "usa", role: "org:admin" },
    ],
    locateOnly: true,
  },
  {
    slug: "daniel",
    name: "Daniel Hale",
    email: "daniel.fs+tractionos-seed@example.com",
    memberships: [{ org: "fs", role: "org:member" }],
  },
  {
    slug: "nick",
    name: "Nick Reyes",
    email: "nick.bl+tractionos-seed@example.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  {
    slug: "andrew",
    name: "Andrew Patel",
    email: "andrew.usa+tractionos-seed@example.com",
    memberships: [{ org: "usa", role: "org:member" }],
  },
  {
    slug: "craig",
    name: "Craig Lawson",
    email: "craig.ops+tractionos-seed@example.com",
    memberships: [
      { org: "fs", role: "org:member" },
      { org: "bl", role: "org:member" },
      { org: "usa", role: "org:member" },
    ],
  },
  {
    slug: "tom",
    name: "Tom McGrath",
    email: "tom.fs+tractionos-seed@example.com",
    memberships: [{ org: "fs", role: "org:member" }],
  },
  {
    slug: "chip",
    name: "Chip Walters",
    email: "chip.ops+tractionos-seed@example.com",
    memberships: [
      { org: "fs", role: "org:member" },
      { org: "bl", role: "org:member" },
      { org: "usa", role: "org:member" },
    ],
  },
  {
    slug: "chrisb",
    name: "Chris Barnes",
    email: "chrisb.bl+tractionos-seed@example.com",
    memberships: [{ org: "bl", role: "org:member" }],
  },
  // Mike is in USA only — fitting the free Clerk tier's 5-member-per-org cap.
  // (FS=5 with daniel/tom/craig/chip+tim, BL=5 with nick/chrisb/craig/chip+tim,
  // USA=5 with andrew/craig/chip/mike+tim.) Cross-org ownership in the local
  // DB is independent of Clerk membership; Mike's USA-hosted logistics rock
  // surfaces correctly under his sign-in.
  {
    slug: "mike",
    name: "Mike Devereaux",
    email: "mike.logistics+tractionos-seed@example.com",
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

// Per docs/kpi-definitions.md §"Per-entity replication". Tim's accounting
// KPIs (DSO/DPO/AR Coll), Craig's inventory KPIs, and Chip's open-orders +
// on-time KPIs replicate per org under ADR-0009.
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
  { org: "bl", name: "Fill Rate %", owner: "chrisb", unit: "%", formatHint: "percent", goalDirection: "gte", goalValue: 0.95, cadence: "weekly", formula: "Lines Shipped Complete / Total Lines Ordered" },
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
  { org: "bl", description: "Update company SOPs", owner: "daniel", status: "on_track" },
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

/** Last 3 Friday week-endings, in chronological order (oldest first). */
function lastThreeFridays(today: Date): Date[] {
  const result: Date[] = [];
  const d = new Date(today);
  // Walk back to the most recent Friday (Friday = day 5).
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
  const dayNumber = (target.getUTCDay() + 6) % 7; // Mon=0
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

/** Plausible actual given goal direction. weekIdx: 0=oldest, 2=newest.
 *  Mostly trending toward the goal; some seeded variance per measurable. */
function plausibleActual(
  spec: MeasurableSpec,
  weekIdx: number,
  variance: number, // 0..1 stable per measurable
): number {
  const noise = (variance - 0.5) * 0.04; // ±2% noise per measurable
  if (spec.goalDirection === "gte" && spec.goalValue !== null) {
    // Start ~15% under, end ~3% under or over depending on variance.
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
    // Backlog falling over time, somewhere around $1.5M.
    return round(1_500_000 - weekIdx * 90_000 + variance * 50_000, spec);
  }
  return round(0, spec);
}

function round(n: number, spec: MeasurableSpec): number {
  if (spec.formatHint === "percent") return Math.round(n * 10_000) / 10_000; // 4 decimals
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
  // Look up by email first.
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

async function ensureMembership(
  orgId: string,
  userId: string,
  role: "org:admin" | "org:member",
) {
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
    return;
  }
  await clerk.organizations.createOrganizationMembership({
    organizationId: orgId,
    userId,
    role,
  });
}

/** Remove memberships of `userId` that aren't in `keepOrgIds`. Idempotent —
 *  used so re-running the seed after a spec change converges Clerk state. */
async function pruneMemberships(
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // 1) Orgs
  const orgIdBySlug: Record<OrgSlug, string> = {} as Record<OrgSlug, string>;
  for (const o of ORG_SPECS) {
    const clerkOrg = await findOrgBySlug(o.slug);
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

  // 2) People (Clerk users + memberships + local rows)
  const personIdBySlug: Record<PersonSlug, string> = {} as Record<PersonSlug, string>;
  const fsClerkOrgId = (await findOrgBySlug("fs")).id;
  for (const p of PEOPLE_SPEC) {
    const clerkUserId = p.locateOnly
      ? await findExistingTim(fsClerkOrgId)
      : await findOrCreateClerkUser(p);

    const allOrgClerkIds = await Promise.all(
      ORG_SPECS.map((o) => findOrgBySlug(o.slug).then((co) => co.id)),
    );
    const wantOrgIds = new Set(
      await Promise.all(
        p.memberships.map((m) => findOrgBySlug(m.org).then((co) => co.id)),
      ),
    );

    // Drop extras first — frees seats so the next person can fit.
    await pruneMemberships(clerkUserId, wantOrgIds, allOrgClerkIds);

    for (const m of p.memberships) {
      const orgClerkId = (await findOrgBySlug(m.org)).id;
      await ensureMembership(orgClerkId, clerkUserId, m.role);
    }

    // Local people row keyed on clerk_user_id.
    const existing = await db
      .select()
      .from(people)
      .where(eq(people.clerkUserId, clerkUserId))
      .limit(1);
    if (existing[0]) {
      personIdBySlug[p.slug] = existing[0].id;
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
    console.log(`[seed] user ${p.slug.padEnd(7)} ${clerkUserId}`);
  }

  // 3) Measurables — upsert by (orgId, name).
  const measurableIdByKey: Record<string, string> = {};
  let mCount = 0;
  for (const m of MEASURABLES_SPEC) {
    const orgId = orgIdBySlug[m.org];
    const existing = await db
      .select()
      .from(measurables)
      .where(and(eq(measurables.orgId, orgId), eq(measurables.name, m.name)))
      .limit(1);
    let id: string;
    if (existing[0]) {
      id = existing[0].id;
    } else {
      const inserted = await db
        .insert(measurables)
        .values({
          orgId,
          name: m.name,
          ownerId: personIdBySlug[m.owner],
          unit: m.unit,
          formatHint: m.formatHint,
          goalDirection: m.goalDirection,
          goalValue: m.goalValue !== null ? String(m.goalValue) : null,
          cadence: m.cadence,
          formula: m.formula,
          displayOrder: mCount * 10,
        })
        .returning({ id: measurables.id });
      id = inserted[0]!.id;
    }
    measurableIdByKey[`${m.org}:${m.name}`] = id;
    mCount++;
  }
  console.log(`[seed] measurables: ${mCount} total`);

  // 4) Weeks — last 3 Fridays.
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

  // 5) Entries — 30 measurables × 3 weeks = 90 rows.
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

  // 6) Rocks.
  const q2_2026 = "Q2 2026";
  const q2End = "2026-06-30";
  let rCount = 0;
  for (const r of ROCKS_SPEC) {
    const existing = await db
      .select({ id: rocks.id })
      .from(rocks)
      .where(
        and(
          eq(rocks.orgId, orgIdBySlug[r.org]),
          eq(rocks.description, r.description),
          eq(rocks.quarter, q2_2026),
        ),
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(rocks).values({
      orgId: orgIdBySlug[r.org],
      description: r.description,
      ownerId: personIdBySlug[r.owner],
      quarter: q2_2026,
      dueDate: q2End,
      status: r.status,
      notes: r.notes,
    });
    rCount++;
  }
  console.log(`[seed] rocks inserted: ${rCount} (skipped existing)`);

  // 7) Issues.
  let iCount = 0;
  for (const i of ISSUES_SPEC) {
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(eq(issues.orgId, orgIdBySlug[i.org]), eq(issues.title, i.title)),
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(issues).values({
      orgId: orgIdBySlug[i.org],
      title: i.title,
      priority: i.priority,
      ownerId: personIdBySlug[i.owner],
      rootCause: i.rootCause,
      status: "open",
    });
    iCount++;
  }
  console.log(`[seed] issues inserted: ${iCount} (skipped existing)`);

  console.log("[seed] done.");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
