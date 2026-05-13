// Org-wide readiness query for the /admin/readiness page. Strictly scoped
// to a single orgId — no cross-org reads.
//
// Eligible set per the user's rule "scoreboard obligation = only people
// assigned a metric, to-do, or quarterly rock":
//
//   org_memberships(org)
//     ⨝ people
//     filter: person owns at least one (measurable | open todo | active rock)
//             in this org
//
// org_memberships is the canonical roster (DATA_MODEL_DECISION.md §3).
// Ownership tables provide the "obligation" filter. Anyone in the org with
// no measurable, no open todo, and no active rock simply doesn't appear —
// they have nothing to be ready for.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  measurables,
  orgMemberships,
  people,
  rocks,
  todos,
  type Person,
} from "@/lib/db/schema";
import {
  computeReadiness,
  type ReadinessResult,
} from "@/lib/readiness/compute-readiness";

export interface OrgReadinessRow {
  person: Pick<Person, "id" | "name" | "email" | "avatarUrl"> & {
    role: "admin" | "member" | "viewer";
  };
  readiness: ReadinessResult;
}

/** Returns one row per obligated org member, sorted red first then yellow
 *  then green (within color, most-missing first, then alpha). */
export async function getOrgReadiness(
  orgId: string,
  currentWeekId: string | null,
  today: string,
): Promise<OrgReadinessRow[]> {
  // 1. Roster: every member of this org, with their per-org role.
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

  // 2. All measurables owned by these members in this org.
  const ms = await db
    .select({
      id: measurables.id,
      ownerId: measurables.ownerId,
    })
    .from(measurables)
    .where(
      and(eq(measurables.orgId, orgId), inArray(measurables.ownerId, memberIds)),
    );

  // 3. Current-week entries for those measurables.
  const measurableIds = ms.map((m) => m.id);
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
  for (const e of currentEntries) {
    actualByMeasurable.set(e.measurableId, e.actual);
  }

  // 4. Open / rolled-over to-dos owned by these members in this org.
  const openTodos = await db
    .select({
      id: todos.id,
      ownerId: todos.ownerId,
      dueDate: todos.dueDate,
    })
    .from(todos)
    .where(
      and(
        eq(todos.orgId, orgId),
        inArray(todos.status, ["open", "rolled_over"]),
        inArray(todos.ownerId, memberIds),
      ),
    );

  // 5. Active (not-completed) rocks owned by these members in this org —
  //    used only as an obligation signal for the eligible set, not in the
  //    readiness math itself (rock status changes happen during the L10).
  const activeRocks = await db
    .select({ ownerId: rocks.ownerId })
    .from(rocks)
    .where(
      and(
        eq(rocks.orgId, orgId),
        inArray(rocks.status, ["on_track", "off_track"]),
        inArray(rocks.ownerId, memberIds),
      ),
    );

  // 6. Group obligations per person.
  const measurablesByOwner = new Map<string, typeof ms>();
  for (const m of ms) {
    const arr = measurablesByOwner.get(m.ownerId) ?? [];
    arr.push(m);
    measurablesByOwner.set(m.ownerId, arr);
  }
  const todosByOwner = new Map<string, typeof openTodos>();
  for (const t of openTodos) {
    const arr = todosByOwner.get(t.ownerId) ?? [];
    arr.push(t);
    todosByOwner.set(t.ownerId, arr);
  }
  const rockOwners = new Set<string>();
  for (const r of activeRocks) rockOwners.add(r.ownerId);

  // 7. Filter to obligated members + compute readiness.
  const rows: OrgReadinessRow[] = memberRows
    .filter((p) => {
      const hasMeasurable = (measurablesByOwner.get(p.id)?.length ?? 0) > 0;
      const hasTodo = (todosByOwner.get(p.id)?.length ?? 0) > 0;
      const hasRock = rockOwners.has(p.id);
      return hasMeasurable || hasTodo || hasRock;
    })
    .map((person) => {
      const owned = measurablesByOwner.get(person.id) ?? [];
      const todosFor = todosByOwner.get(person.id) ?? [];
      const readiness = computeReadiness({
        measurables: owned.map((m) => ({
          measurableId: m.id,
          currentActual: parseNumeric(actualByMeasurable.get(m.id) ?? null),
        })),
        openTodos: todosFor.map((t) => ({ todoId: t.id, dueDate: t.dueDate })),
        today,
      });
      return { person, readiness };
    });

  const STATUS_ORDER: Record<ReadinessResult["status"], number> = {
    red: 0,
    yellow: 1,
    green: 2,
  };
  rows.sort((a, b) => {
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
