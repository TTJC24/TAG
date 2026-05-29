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
 *  Weeks are auto-generated lazily on scorecard load — see ensureCurrentWeek. */
export async function getRecentWeeks(limit = 3): Promise<Week[]> {
  const rows = await db
    .select()
    .from(weeks)
    .orderBy(desc(weeks.weekEndingDate))
    .limit(limit);
  return rows.slice().reverse();
}

// ── Week generation (lazy, idempotent) ──────────────────────────────────────
// Weeks are anchored to Mondays (matching the imported workbook: 2026-04-27,
// 05-04, 05-11 are all Mondays on a 7-day cadence). The week's slot key is the
// Monday of the current week. See ADR-0012.

function isoWeek(d: Date): number {
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

/** The Monday on or before `now` (UTC), as YYYY-MM-DD. The current week's slot. */
export function currentWeekEndingDate(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const sinceMonday = (d.getUTCDay() + 6) % 7; // 0 when Monday
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  return d.toISOString().slice(0, 10);
}

/** "Q{n} {year}" for the current week — matches the workbook quarter format. */
export function currentQuarter(now: Date = new Date()): string {
  const d = new Date(currentWeekEndingDate(now) + "T00:00:00Z");
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

/** Ensures a `weeks` row exists for the current week and returns it. Idempotent
 *  and concurrency-safe: the insert no-ops on the weekEndingDate unique index,
 *  so two simultaneous loads can't create duplicate weeks. No cron — the act of
 *  loading the scorecard is the trigger. See ADR-0012. */
export async function ensureCurrentWeek(now: Date = new Date()): Promise<Week> {
  const weekEndingDate = currentWeekEndingDate(now);
  const anchor = new Date(weekEndingDate + "T00:00:00Z");
  await db
    .insert(weeks)
    .values({
      weekEndingDate,
      weekNumber: isoWeek(anchor),
      quarter: `Q${Math.floor(anchor.getUTCMonth() / 3) + 1} ${anchor.getUTCFullYear()}`,
      fiscalYear: anchor.getUTCFullYear(),
    })
    .onConflictDoNothing({ target: weeks.weekEndingDate });
  const [row] = await db
    .select()
    .from(weeks)
    .where(eq(weeks.weekEndingDate, weekEndingDate))
    .limit(1);
  return row!;
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
