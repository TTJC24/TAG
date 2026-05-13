// One-shot read-only audit of the canonical data layer.
//
// Run:  pnpm tsx --env-file=.env.local scripts/audit-data.ts > /tmp/audit.txt
//
// Pure SELECTs — no writes, no Clerk calls. Prints structured sections so
// the output drops directly into DATA_RESET_AUDIT.md.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  issues,
  measurables,
  meetings,
  orgMemberships,
  organizations,
  people,
  rocks,
  todos,
  weeks,
} from "@/lib/db/schema";

function hr(title: string) {
  console.log("");
  console.log(`### ${title}`);
  console.log("");
}

async function main() {
  // ─── 1. Canonical people per org ─────────────────────────────────────
  hr("1. Canonical people per org");
  const orgs = await db
    .select()
    .from(organizations)
    .orderBy(organizations.code);
  for (const o of orgs) {
    const members = await db
      .select({
        name: people.name,
        email: people.email,
        role: orgMemberships.role,
        personId: people.id,
        clerkUserId: people.clerkUserId,
      })
      .from(orgMemberships)
      .innerJoin(people, eq(orgMemberships.personId, people.id))
      .where(eq(orgMemberships.orgId, o.id))
      .orderBy(people.name);
    console.log(`Org: ${o.name} (code=${o.code}, clerk=${o.clerkOrgId})`);
    for (const m of members) {
      console.log(
        `  - ${m.name.padEnd(22)} ${m.email.padEnd(48)} role=${m.role.padEnd(7)} person=${m.personId} clerk=${m.clerkUserId}`,
      );
    }
    console.log(`  total members: ${members.length}`);
  }

  // ─── 2. org_memberships rows ─────────────────────────────────────────
  hr("2. org_memberships rows");
  const allMemberships = await db
    .select({
      orgCode: organizations.code,
      personName: people.name,
      role: orgMemberships.role,
      createdAt: orgMemberships.createdAt,
    })
    .from(orgMemberships)
    .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id))
    .innerJoin(people, eq(orgMemberships.personId, people.id))
    .orderBy(organizations.code, orgMemberships.role, people.name);
  console.log(`Total org_memberships rows: ${allMemberships.length}`);
  for (const m of allMemberships) {
    console.log(
      `  ${m.orgCode.padEnd(4)} ${m.role.padEnd(7)} ${m.personName}`,
    );
  }

  // ─── 3. Email → person mapping ───────────────────────────────────────
  hr("3. Email -> person mapping");
  const emailMap = await db
    .select({
      email: people.email,
      name: people.name,
      personId: people.id,
      clerkUserId: people.clerkUserId,
    })
    .from(people)
    .orderBy(people.email);
  for (const p of emailMap) {
    console.log(
      `  ${p.email.padEnd(48)} -> ${p.name.padEnd(22)} person=${p.personId} clerk=${p.clerkUserId}`,
    );
  }
  console.log(`  total people rows: ${emailMap.length}`);

  // ─── 4. Scoreboard-obligated people per org ──────────────────────────
  hr("4. Scoreboard-obligated people per org");
  for (const o of orgs) {
    console.log(`\nOrg: ${o.name}`);
    // For each member, count measurables/todos/rocks they own in this org.
    const members = await db
      .select({
        personId: people.id,
        name: people.name,
        role: orgMemberships.role,
      })
      .from(orgMemberships)
      .innerJoin(people, eq(orgMemberships.personId, people.id))
      .where(eq(orgMemberships.orgId, o.id))
      .orderBy(people.name);
    for (const m of members) {
      const mc = await db
        .select({ c: sql<number>`count(*)::int`.as("c") })
        .from(measurables)
        .where(
          and(
            eq(measurables.orgId, o.id),
            eq(measurables.ownerId, m.personId),
          ),
        );
      const rc = await db
        .select({ c: sql<number>`count(*)::int`.as("c") })
        .from(rocks)
        .where(and(eq(rocks.orgId, o.id), eq(rocks.ownerId, m.personId)));
      const tc = await db
        .select({ c: sql<number>`count(*)::int`.as("c") })
        .from(todos)
        .where(and(eq(todos.orgId, o.id), eq(todos.ownerId, m.personId)));
      const ic = await db
        .select({ c: sql<number>`count(*)::int`.as("c") })
        .from(issues)
        .where(and(eq(issues.orgId, o.id), eq(issues.ownerId, m.personId)));
      const metricCount = Number(mc[0]?.c ?? 0);
      const rockCount = Number(rc[0]?.c ?? 0);
      const todoCount = Number(tc[0]?.c ?? 0);
      const issueCount = Number(ic[0]?.c ?? 0);
      const obligated = metricCount > 0 || rockCount > 0 || todoCount > 0;
      const why: string[] = [];
      if (metricCount > 0) why.push(`${metricCount} metric${metricCount === 1 ? "" : "s"}`);
      if (rockCount > 0) why.push(`${rockCount} rock${rockCount === 1 ? "" : "s"}`);
      if (todoCount > 0) why.push(`${todoCount} todo${todoCount === 1 ? "" : "s"}`);
      const issueNote = issueCount > 0 ? ` (+${issueCount} issue${issueCount === 1 ? "" : "s"})` : "";
      const status = obligated ? "OBLIGATED" : "  not    ";
      console.log(
        `  [${status}] ${m.name.padEnd(22)} ${(why.join(", ") || "no obligations").padEnd(40)}${issueNote}`,
      );
    }
  }

  // ─── 5. Domain row counts (aka "what was imported") ──────────────────
  hr("5. Domain rows present per org");
  for (const o of orgs) {
    const mList = await db
      .select({ name: measurables.name, owner: people.name })
      .from(measurables)
      .innerJoin(people, eq(measurables.ownerId, people.id))
      .where(eq(measurables.orgId, o.id))
      .orderBy(measurables.displayOrder);
    const rList = await db
      .select({ description: rocks.description, owner: people.name, status: rocks.status })
      .from(rocks)
      .innerJoin(people, eq(rocks.ownerId, people.id))
      .where(eq(rocks.orgId, o.id))
      .orderBy(rocks.dueDate);
    const tList = await db
      .select({ description: todos.description, owner: people.name, status: todos.status })
      .from(todos)
      .innerJoin(people, eq(todos.ownerId, people.id))
      .where(eq(todos.orgId, o.id));
    const iList = await db
      .select({ title: issues.title, owner: people.name, priority: issues.priority })
      .from(issues)
      .innerJoin(people, eq(issues.ownerId, people.id))
      .where(eq(issues.orgId, o.id));
    console.log(`\nOrg: ${o.name}`);
    console.log(`  Measurables: ${mList.length}`);
    for (const m of mList) console.log(`    - ${m.name.padEnd(28)} owner=${m.owner}`);
    console.log(`  Rocks: ${rList.length}`);
    for (const r of rList)
      console.log(`    - [${r.status.padEnd(10)}] ${r.description.padEnd(50)} owner=${r.owner}`);
    console.log(`  Todos: ${tList.length}`);
    for (const t of tList)
      console.log(`    - [${t.status.padEnd(10)}] ${t.description.padEnd(50)} owner=${t.owner}`);
    console.log(`  Issues: ${iList.length}`);
    for (const i of iList)
      console.log(`    - [${i.priority.padEnd(8)}] ${i.title.padEnd(60)} owner=${i.owner}`);
  }

  // Weekly meeting history (weeks + entries + meetings)
  hr("5b. Weekly meeting history");
  const allWeeks = await db
    .select()
    .from(weeks)
    .orderBy(weeks.weekEndingDate);
  console.log(`weeks rows: ${allWeeks.length}`);
  for (const w of allWeeks) {
    const ec = await db
      .select({ c: sql<number>`count(*)::int`.as("c") })
      .from(entries)
      .where(eq(entries.weekId, w.id));
    console.log(
      `  - ${w.weekEndingDate}  q=${w.quarter}  iso_week=${w.weekNumber}  entries=${Number(ec[0]?.c ?? 0)}`,
    );
  }
  const allMeetings = await db.select().from(meetings);
  console.log(`meetings rows: ${allMeetings.length}`);

  // ─── 6. Mismatches and duplicates ────────────────────────────────────
  hr("6. Mismatches and duplicates");

  // Duplicate emails (case-insensitive)
  const dupEmails = await db.execute(
    sql`SELECT lower(email) AS email_lc, COUNT(*) AS c
        FROM people GROUP BY lower(email) HAVING COUNT(*) > 1`,
  );
  console.log(`Duplicate emails (case-insensitive): ${dupEmails.rows.length}`);
  for (const r of dupEmails.rows)
    console.log(`  - ${r.email_lc} (count=${r.c})`);

  // Duplicate names
  const dupNames = await db.execute(
    sql`SELECT name, COUNT(*) AS c
        FROM people GROUP BY name HAVING COUNT(*) > 1`,
  );
  console.log(`Duplicate names: ${dupNames.rows.length}`);
  for (const r of dupNames.rows) console.log(`  - ${r.name} (count=${r.c})`);

  // Duplicate clerk_user_ids (should never happen — there's a unique index)
  const dupClerk = await db.execute(
    sql`SELECT clerk_user_id, COUNT(*) AS c
        FROM people GROUP BY clerk_user_id HAVING COUNT(*) > 1`,
  );
  console.log(`Duplicate clerk_user_id: ${dupClerk.rows.length}`);

  // Orphan people: have no org_memberships row at all
  const orphans = await db.execute(
    sql`SELECT p.id, p.name, p.email
        FROM people p
        LEFT JOIN org_memberships om ON om.person_id = p.id
        WHERE om.id IS NULL`,
  );
  console.log(`People with no org_membership: ${orphans.rows.length}`);
  for (const r of orphans.rows)
    console.log(`  - ${r.name} (${r.email})`);

  // Cross-org owner contamination: a measurable in org X owned by someone
  // who is NOT a member of org X.
  const xMeasurables = await db.execute(
    sql`SELECT m.id, m.name, o.code AS org_code, p.name AS owner_name
        FROM measurables m
        JOIN organizations o ON o.id = m.org_id
        JOIN people p ON p.id = m.owner_id
        WHERE NOT EXISTS (
          SELECT 1 FROM org_memberships om
          WHERE om.org_id = m.org_id AND om.person_id = m.owner_id
        )`,
  );
  console.log(
    `Measurables owned by non-members of their org: ${xMeasurables.rows.length}`,
  );
  for (const r of xMeasurables.rows)
    console.log(`  - ${r.org_code} :: ${r.name} (owner=${r.owner_name})`);

  const xRocks = await db.execute(
    sql`SELECT r.id, r.description, o.code AS org_code, p.name AS owner_name
        FROM rocks r
        JOIN organizations o ON o.id = r.org_id
        JOIN people p ON p.id = r.owner_id
        WHERE NOT EXISTS (
          SELECT 1 FROM org_memberships om
          WHERE om.org_id = r.org_id AND om.person_id = r.owner_id
        )`,
  );
  console.log(`Rocks owned by non-members of their org: ${xRocks.rows.length}`);
  for (const r of xRocks.rows)
    console.log(`  - ${r.org_code} :: ${r.description} (owner=${r.owner_name})`);

  const xIssues = await db.execute(
    sql`SELECT i.id, i.title, o.code AS org_code, p.name AS owner_name
        FROM issues i
        JOIN organizations o ON o.id = i.org_id
        JOIN people p ON p.id = i.owner_id
        WHERE NOT EXISTS (
          SELECT 1 FROM org_memberships om
          WHERE om.org_id = i.org_id AND om.person_id = i.owner_id
        )`,
  );
  console.log(
    `Issues owned by non-members of their org: ${xIssues.rows.length}`,
  );
  for (const r of xIssues.rows)
    console.log(`  - ${r.org_code} :: ${r.title} (owner=${r.owner_name})`);

  console.log("\n[audit] done.");
}

main().catch((err) => {
  console.error("[audit] failed:", err);
  process.exit(1);
});
