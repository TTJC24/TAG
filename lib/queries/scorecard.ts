// Org-wide scorecard queries. All callers must pass orgId from a resolved
// AuthContext — there is no path that pulls cross-org data.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  measurables,
  people,
  type Entry,
  type Measurable,
  type Person,
} from "@/lib/db/schema";

export interface ScorecardRow {
  measurable: Measurable;
  owner: Pick<Person, "id" | "name" | "avatarUrl"> | null;
  entriesByWeek: Record<string, Entry | undefined>;
}

export async function getOrgScorecard(
  orgId: string,
  weekIds: string[],
): Promise<ScorecardRow[]> {
  const rows = await db
    .select({
      measurable: measurables,
      owner: {
        id: people.id,
        name: people.name,
        avatarUrl: people.avatarUrl,
      },
    })
    .from(measurables)
    .leftJoin(people, eq(measurables.ownerId, people.id))
    .where(eq(measurables.orgId, orgId))
    .orderBy(asc(measurables.displayOrder));

  if (rows.length === 0 || weekIds.length === 0) {
    return rows.map((r) => ({
      measurable: r.measurable,
      owner: r.owner?.id ? r.owner : null,
      entriesByWeek: {},
    }));
  }

  const ids = rows.map((r) => r.measurable.id);
  const allEntries = await db
    .select()
    .from(entries)
    .where(
      and(inArray(entries.measurableId, ids), inArray(entries.weekId, weekIds)),
    );
  const byMeasurable: Record<string, Record<string, Entry>> = {};
  for (const e of allEntries) {
    if (!byMeasurable[e.measurableId]) byMeasurable[e.measurableId] = {};
    byMeasurable[e.measurableId]![e.weekId] = e;
  }

  return rows.map((r) => ({
    measurable: r.measurable,
    owner: r.owner?.id ? r.owner : null,
    entriesByWeek: byMeasurable[r.measurable.id] ?? {},
  }));
}
