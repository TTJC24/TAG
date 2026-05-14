// Org-wide team view for /admin/readiness. Strictly scoped to a single
// orgId — no cross-org reads.
//
// Returns one row per member of the active org with the full set of
// items they own in that org: measurables (with this week's actual),
// rocks, open to-dos, open issues. The `computeReadiness` verdict is
// also attached for the existing red/yellow/green pill.
//
// Members with zero obligations are still returned (so the admin can
// see the full roster) — flagged as `obligated: false`. The readiness
// computation is a no-op for them and yields a "Nothing assigned"
// label.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  issues,
  measurables,
  orgMemberships,
  people,
  rocks,
  todos,
  type Issue,
  type Measurable,
  type Person,
  type Rock,
  type Todo,
} from "@/lib/db/schema";
import {
  computeReadiness,
  type ReadinessResult,
} from "@/lib/readiness/compute-readiness";

export interface TeamMeasurable {
  measurable: Pick<
    Measurable,
    "id" | "name" | "formatHint" | "goalDirection" | "goalValue" | "goalSecondary" | "cadence"
  >;
  /** Numeric actual for the current week, or null when no entry / null actual. */
  currentActual: number | null;
}

export interface OrgTeamMember {
  person: Pick<Person, "id" | "name" | "email" | "avatarUrl"> & {
    role: "admin" | "member" | "viewer";
  };
  obligated: boolean;
  readiness: ReadinessResult;
  measurables: TeamMeasurable[];
  rocks: Pick<Rock, "id" | "description" | "status" | "dueDate" | "notes">[];
  todos: Pick<Todo, "id" | "description" | "dueDate" | "status" | "rolloverCount">[];
  issues: Pick<Issue, "id" | "title" | "priority" | "rootCause">[];
}

/** Returns the full team view for an org. Sort order:
 *    red obligated → yellow obligated → green obligated → not obligated.
 *  Within each band, more-missing first then alpha. */
export async function getOrgTeamView(
  orgId: string,
  currentWeekId: string | null,
  today: string,
): Promise<OrgTeamMember[]> {
  // 1. Roster: every member of this org.
  const memberRows = await db
    .select({
      id: people.id,
      name: people.name,
      email: people.email,
      avatarUrl: people.avatarUrl,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(people, eq(orgMemberships.personId, people.id))
    .where(eq(orgMemberships.orgId, orgId))
    .orderBy(asc(people.name));

  if (memberRows.length === 0) return [];
  const memberIds = memberRows.map((p) => p.id);

  // 2. All measurables in this org owned by these members (full row).
  const orgMeasurables = await db
    .select({
      id: measurables.id,
      ownerId: measurables.ownerId,
      name: measurables.name,
      formatHint: measurables.formatHint,
      goalDirection: measurables.goalDirection,
      goalValue: measurables.goalValue,
      goalSecondary: measurables.goalSecondary,
      cadence: measurables.cadence,
      displayOrder: measurables.displayOrder,
    })
    .from(measurables)
    .where(
      and(
        eq(measurables.orgId, orgId),
        inArray(measurables.ownerId, memberIds),
        isNull(measurables.archivedAt),
      ),
    )
    .orderBy(asc(measurables.displayOrder));

  // 3. Current-week entries for those measurables.
  const measurableIds = orgMeasurables.map((m) => m.id);
  const currentEntries =
    currentWeekId && measurableIds.length > 0
      ? await db
          .select({
            measurableId: entries.measurableId,
            actual: entries.actual,
          })
          .from(entries)
          .where(
            and(
              eq(entries.weekId, currentWeekId),
              inArray(entries.measurableId, measurableIds),
            ),
          )
      : [];
  const actualByMeasurable = new Map<string, string | null>();
  for (const e of currentEntries) actualByMeasurable.set(e.measurableId, e.actual);

  // 4. Rocks for the org (any non-completed status surfaces).
  const orgRocks = await db
    .select({
      id: rocks.id,
      ownerId: rocks.ownerId,
      description: rocks.description,
      status: rocks.status,
      dueDate: rocks.dueDate,
      notes: rocks.notes,
    })
    .from(rocks)
    .where(and(eq(rocks.orgId, orgId), inArray(rocks.ownerId, memberIds)))
    .orderBy(asc(rocks.dueDate));

  // 5. Open / rolled-over to-dos.
  const orgTodos = await db
    .select({
      id: todos.id,
      ownerId: todos.ownerId,
      description: todos.description,
      dueDate: todos.dueDate,
      status: todos.status,
      rolloverCount: todos.rolloverCount,
    })
    .from(todos)
    .where(
      and(
        eq(todos.orgId, orgId),
        inArray(todos.status, ["open", "rolled_over"]),
        inArray(todos.ownerId, memberIds),
      ),
    )
    .orderBy(asc(todos.dueDate));

  // 6. Open / IDS-in-progress issues.
  const orgIssues = await db
    .select({
      id: issues.id,
      ownerId: issues.ownerId,
      title: issues.title,
      priority: issues.priority,
      rootCause: issues.rootCause,
    })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        inArray(issues.status, ["open", "ids_in_progress"]),
        inArray(issues.ownerId, memberIds),
      ),
    )
    .orderBy(asc(issues.createdAt));

  // 7. Group per person + compute readiness.
  const measurablesByOwner = new Map<string, typeof orgMeasurables>();
  for (const m of orgMeasurables) {
    const arr = measurablesByOwner.get(m.ownerId) ?? [];
    arr.push(m);
    measurablesByOwner.set(m.ownerId, arr);
  }
  const rocksByOwner = new Map<string, typeof orgRocks>();
  for (const r of orgRocks) {
    const arr = rocksByOwner.get(r.ownerId) ?? [];
    arr.push(r);
    rocksByOwner.set(r.ownerId, arr);
  }
  const todosByOwner = new Map<string, typeof orgTodos>();
  for (const t of orgTodos) {
    const arr = todosByOwner.get(t.ownerId) ?? [];
    arr.push(t);
    todosByOwner.set(t.ownerId, arr);
  }
  const issuesByOwner = new Map<string, typeof orgIssues>();
  for (const i of orgIssues) {
    const arr = issuesByOwner.get(i.ownerId) ?? [];
    arr.push(i);
    issuesByOwner.set(i.ownerId, arr);
  }

  const rows: OrgTeamMember[] = memberRows.map((person) => {
    const ms = measurablesByOwner.get(person.id) ?? [];
    const rs = rocksByOwner.get(person.id) ?? [];
    const ts = todosByOwner.get(person.id) ?? [];
    const is = issuesByOwner.get(person.id) ?? [];
    const obligated = ms.length > 0 || rs.length > 0 || ts.length > 0;
    const readiness = computeReadiness({
      measurables: ms.map((m) => ({
        measurableId: m.id,
        currentActual: parseNumeric(actualByMeasurable.get(m.id) ?? null),
      })),
      openTodos: ts.map((t) => ({ todoId: t.id, dueDate: t.dueDate })),
      today,
    });
    return {
      person,
      obligated,
      readiness,
      measurables: ms.map((m) => ({
        measurable: {
          id: m.id,
          name: m.name,
          formatHint: m.formatHint,
          goalDirection: m.goalDirection,
          goalValue: m.goalValue,
          goalSecondary: m.goalSecondary,
          cadence: m.cadence,
        },
        currentActual: parseNumeric(actualByMeasurable.get(m.id) ?? null),
      })),
      rocks: rs.map((r) => ({
        id: r.id,
        description: r.description,
        status: r.status,
        dueDate: r.dueDate,
        notes: r.notes,
      })),
      todos: ts.map((t) => ({
        id: t.id,
        description: t.description,
        dueDate: t.dueDate,
        status: t.status,
        rolloverCount: t.rolloverCount,
      })),
      issues: is.map((i) => ({
        id: i.id,
        title: i.title,
        priority: i.priority,
        rootCause: i.rootCause,
      })),
    };
  });

  // Sort: obligated red → obligated yellow → obligated green → not obligated.
  // Within each tier, more outstanding items first then alpha.
  const STATUS_ORDER: Record<ReadinessResult["status"], number> = {
    red: 0,
    yellow: 1,
    green: 2,
  };
  rows.sort((a, b) => {
    if (a.obligated !== b.obligated) return a.obligated ? -1 : 1;
    const oa = STATUS_ORDER[a.readiness.status];
    const ob = STATUS_ORDER[b.readiness.status];
    if (oa !== ob) return oa - ob;
    const am = a.readiness.missingMeasurables + a.readiness.overdueTodos;
    const bm = b.readiness.missingMeasurables + b.readiness.overdueTodos;
    if (am !== bm) return bm - am;
    return a.person.name.localeCompare(b.person.name);
  });

  return rows;
}

function parseNumeric(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Back-compat: the older obligation-only shape consumed by lib/nudges/dispatch.
// Returns one row per *obligated* member (the readiness verdict only matters
// for people who actually have something to report on).
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgReadinessRow {
  person: Pick<Person, "id" | "name" | "email" | "avatarUrl"> & {
    role: "admin" | "member" | "viewer";
  };
  readiness: ReadinessResult;
}

export async function getOrgReadiness(
  orgId: string,
  currentWeekId: string | null,
  today: string,
): Promise<OrgReadinessRow[]> {
  const team = await getOrgTeamView(orgId, currentWeekId, today);
  return team
    .filter((m) => m.obligated)
    .map((m) => ({ person: m.person, readiness: m.readiness }));
}
