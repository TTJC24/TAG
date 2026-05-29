// Server-side queries for the /me personal dashboard. Strictly org-scoped:
// every query joins on org_id from the caller's AuthContext so cross-org
// reads are impossible by construction.

import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  issues,
  measurables,
  meetings,
  rocks,
  todos,
  weeks,
  type Entry,
  type Issue,
  type Measurable,
  type Meeting,
  type Rock,
  type Todo,
  type Week,
} from "@/lib/db/schema";

/** Most recent N weeks across the platform, oldest-first.
 *  Phase 1 seeded three; later phases will manage week creation via cron. */
export async function getRecentWeeks(limit = 3): Promise<Week[]> {
  const rows = await db
    .select()
    .from(weeks)
    .orderBy(desc(weeks.weekEndingDate))
    .limit(limit);
  return rows.slice().reverse();
}

export interface MyMeasurable {
  measurable: Measurable;
  /** Entries indexed by weekId (sparse — a measurable may not have one yet). */
  entriesByWeek: Record<string, Entry | undefined>;
}

/** All measurables owned by `personId` in `orgId`, with entries for the
 *  provided week window. One query per table (2 total) regardless of how
 *  many measurables the user owns. */
export async function getMyMeasurables(
  personId: string,
  orgId: string,
  weekIds: string[],
): Promise<MyMeasurable[]> {
  const myMeasurables = await db
    .select()
    .from(measurables)
    .where(
      and(
        eq(measurables.ownerId, personId),
        eq(measurables.orgId, orgId),
        isNull(measurables.archivedAt),
      ),
    )
    .orderBy(asc(measurables.displayOrder));

  if (myMeasurables.length === 0 || weekIds.length === 0) {
    return myMeasurables.map((m) => ({ measurable: m, entriesByWeek: {} }));
  }

  const ids = myMeasurables.map((m) => m.id);
  const allEntries = await db
    .select()
    .from(entries)
    .where(and(inArray(entries.measurableId, ids), inArray(entries.weekId, weekIds)));

  const byMeasurable: Record<string, Record<string, Entry>> = {};
  for (const e of allEntries) {
    if (!byMeasurable[e.measurableId]) byMeasurable[e.measurableId] = {};
    byMeasurable[e.measurableId]![e.weekId] = e;
  }
  return myMeasurables.map((m) => ({
    measurable: m,
    entriesByWeek: byMeasurable[m.id] ?? {},
  }));
}

export async function getMyRocks(personId: string, orgId: string): Promise<Rock[]> {
  return db
    .select()
    .from(rocks)
    .where(and(eq(rocks.ownerId, personId), eq(rocks.orgId, orgId)))
    .orderBy(asc(rocks.dueDate));
}

export async function getMyOpenTodos(personId: string, orgId: string): Promise<Todo[]> {
  return db
    .select()
    .from(todos)
    .where(
      and(
        eq(todos.ownerId, personId),
        eq(todos.orgId, orgId),
        inArray(todos.status, ["open", "rolled_over"]),
      ),
    )
    .orderBy(asc(todos.dueDate));
}

export async function getMyIssues(personId: string, orgId: string): Promise<Issue[]> {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.ownerId, personId),
        eq(issues.orgId, orgId),
        inArray(issues.status, ["open", "ids_in_progress"]),
      ),
    )
    .orderBy(asc(issues.createdAt));
}

/** The currently-live L10 for this org, or null. Drives the masthead LIVE
 *  pill. Read-only and org-scoped; no write path. */
export async function getLiveMeeting(orgId: string): Promise<Meeting | null> {
  const [row] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.orgId, orgId), eq(meetings.status, "live")))
    .orderBy(desc(meetings.scheduledFor))
    .limit(1);
  return row ?? null;
}

/** Next scheduled L10 for this org, or null if none. Used by the readiness
 *  banner on /me to show "Next L10: …". */
export async function getNextMeeting(
  orgId: string,
  now: Date = new Date(),
): Promise<Meeting | null> {
  const [row] = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.orgId, orgId),
        eq(meetings.status, "scheduled"),
        gte(meetings.scheduledFor, now),
      ),
    )
    .orderBy(asc(meetings.scheduledFor))
    .limit(1);
  return row ?? null;
}
