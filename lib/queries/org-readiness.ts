// Org-wide readiness query for the /admin/readiness page. Strictly scoped
// to a single orgId — no cross-org reads.
//
// "People who matter for L10 prep" = anyone in this org who owns at least
// one measurable. (Rock/to-do-only owners have nothing to pre-fill, so they
// don't surface here.) For each such person we compute the same readiness
// verdict the /me banner uses, off the same primitive in lib/readiness/.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  measurables,
  people,
  todos,
  type Person,
} from "@/lib/db/schema";
import {
  computeReadiness,
  type ReadinessResult,
} from "@/lib/readiness/compute-readiness";

export interface OrgReadinessRow {
  person: Pick<Person, "id" | "name" | "email" | "avatarUrl" | "role">;
  readiness: ReadinessResult;
}

/** Returns one row per person owning ≥1 measurable in `orgId`, sorted red
 *  first then yellow then green (within color, most-missing first). */
export async function getOrgReadiness(
  orgId: string,
  currentWeekId: string | null,
  today: string,
): Promise<OrgReadinessRow[]> {
  // 1. Everyone in this org who owns at least one measurable.
  const ownerRows = await db
    .selectDistinct({
      id: people.id,
      name: people.name,
      email: people.email,
      avatarUrl: people.avatarUrl,
      role: people.role,
    })
    .from(measurables)
    .innerJoin(people, eq(measurables.ownerId, people.id))
    .where(eq(measurables.orgId, orgId))
    .orderBy(asc(people.name));

  if (ownerRows.length === 0) return [];

  const personIds = ownerRows.map((p) => p.id);

  // 2. All measurables in this org, owned by those people.
  const ms = await db
    .select({
      id: measurables.id,
      ownerId: measurables.ownerId,
    })
    .from(measurables)
    .where(
      and(
        eq(measurables.orgId, orgId),
        inArray(measurables.ownerId, personIds),
      ),
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

  // 4. Open to-dos owned by those people in this org.
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
        inArray(todos.ownerId, personIds),
      ),
    );

  // 5. Group + compute per person.
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

  const rows: OrgReadinessRow[] = ownerRows.map((person) => {
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
    // Within color, more-missing or more-overdue first; then alpha.
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
