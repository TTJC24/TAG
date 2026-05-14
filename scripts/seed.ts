// Canonical seed — identity layer only.
//
// Manages: Clerk org names + slugs, local organizations, Clerk users +
// memberships, local people, local org_memberships. Nothing else.
//
// Domain data (measurables, weeks, entries, rocks, todos, issues) is
// owned by scripts/import-workbook.ts. Running this seed alone leaves
// those tables untouched — the workbook import is the bootstrap path.
//
// Run:  pnpm seed
//
// What this script does, in order:
//   1. Cleans up legacy demo Clerk users (emails ending
//      "+tractionos-seed@example.com"). Frees Clerk org seats.
//   2. Mirrors the 3 Clerk orgs into local `organizations`. Drift-corrects
//      Clerk + local org name to the canonical short label
//      (FS / BLCS / USA) on every run.
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
//   5. Cleanup: deletes orphan local `people` rows whose Clerk user no
//      longer exists AND who own nothing.

import { createClerkClient } from "@clerk/backend";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  organizations,
  people,
  orgMemberships,
  measurables,
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

// Short display labels per the user's "one clean short label per org"
// rule. The Clerk org name + local organizations.name are kept aligned
// to these. Slugs and `organizations.code` stay as the lower-case /
// upper-case identifiers (fs / bl / usa) for stable internal lookup
// and for the workbook importer's entity column.
const ORG_SPECS = [
  { slug: "fs", name: "FS" },
  { slug: "bl", name: "BLCS" },
  { slug: "usa", name: "USA" },
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

// Domain data (measurables, weeks, entries, rocks, todos, issues) is owned
// by scripts/import-workbook.ts. The arrays + helpers that previously lived
// here have been removed so re-running the seed cannot regress the workbook
// import.

// ── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_EMAIL_PATTERN = "+tractionos-seed@example.com";

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

  // 1) Orgs — converge Clerk org name + local organizations.name to the
  //    short label spec on every run so renames propagate.
  const orgIdBySlug: Record<OrgSlug, string> = {} as Record<OrgSlug, string>;
  const orgClerkIdBySlug: Record<OrgSlug, string> = {} as Record<OrgSlug, string>;
  for (const o of ORG_SPECS) {
    const clerkOrg = await findOrgBySlug(o.slug);
    orgClerkIdBySlug[o.slug] = clerkOrg.id;

    // Drift-correct the Clerk org name if needed.
    if (clerkOrg.name !== o.name) {
      try {
        await clerk.organizations.updateOrganization(clerkOrg.id, {
          name: o.name,
        });
        console.log(
          `[seed] renamed clerk org "${clerkOrg.name}" → "${o.name}"`,
        );
      } catch (err) {
        console.warn(
          `[seed] failed to rename clerk org ${clerkOrg.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const existing = await db
      .select()
      .from(organizations)
      .where(eq(organizations.clerkOrgId, clerkOrg.id))
      .limit(1);
    if (existing[0]) {
      orgIdBySlug[o.slug] = existing[0].id;
      // Drift-correct the local organizations.name if needed.
      if (existing[0].name !== o.name) {
        await db
          .update(organizations)
          .set({ name: o.name })
          .where(eq(organizations.id, existing[0].id));
        console.log(
          `[seed] renamed local org "${existing[0].name}" → "${o.name}"`,
        );
      }
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

  // Domain data (measurables, weeks, entries, rocks, todos, issues) is
  // owned by scripts/import-workbook.ts. Run that after the seed to
  // populate domain rows from reference/TRACTION_MEETING_TEMPLATE.xlsx.
  console.log(
    "[seed] domain data (measurables/rocks/todos/issues/entries/weeks) is owned by",
  );
  console.log(
    "       scripts/import-workbook.ts — run that next to populate from the workbook.",
  );

  // Cleanup orphan local people rows whose Clerk user is gone AND who own
  // nothing. Preserves any row with FK references intact.
  const orphansDeleted = await cleanupOrphanPeople(validClerkUserIds);
  console.log(`[seed] orphan cleanup: ${orphansDeleted} local people row(s) deleted`);

  console.log("[seed] done.");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
