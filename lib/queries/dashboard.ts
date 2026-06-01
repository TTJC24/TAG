// Cross-entity dashboard aggregation. READ-ONLY and scoped strictly to the
// orgs the current person is a member of (via org_memberships) — it never
// reads an org the user doesn't belong to. This intentionally goes beyond the
// single-active-org model of v1 (ADR-0009 deferred a cross-entity view); it is
// additive and touches no write path.

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { organizations, orgMemberships } from "@/lib/db/schema";
import { getOrgScorecard } from "@/lib/queries/scorecard";
import { getOrgIssues, getOrgRocks } from "@/lib/queries/org-lists";
import { getRecentWeeks } from "@/lib/queries/me";
import { computeStatus } from "@/lib/shading/compute-status";
import type {
  GoalDirection,
  NoteClassification,
  ShadingEntry,
  StatusColor,
} from "@/lib/shading/types";

export interface EntityRef {
  orgId: string;
  clerkOrgId: string;
  name: string;
  code: string;
  role: "admin" | "member" | "viewer";
}

export interface EntityHealth {
  total: number;
  onTrack: number;
  critical: number;
  watch: number;
  missing: number;
  openIssues: number;
  rocksOn: number;
  rocksOff: number;
  signal: StatusColor;
}

/** Every org the person is a member of, with their per-org role. */
export async function getUserEntities(personId: string): Promise<EntityRef[]> {
  const rows = await db
    .select({
      orgId: organizations.id,
      clerkOrgId: organizations.clerkOrgId,
      name: organizations.name,
      code: organizations.code,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(organizations, eq(orgMemberships.orgId, organizations.id))
    .where(eq(orgMemberships.personId, personId))
    .orderBy(asc(organizations.code));
  return rows;
}

function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One entity's health for its most recent week. Weeks are entity-local
 *  (ADR-0013), so this reads the org's own week rows. A glance view — it does
 *  not generate weeks; entities with no weekly cadence simply have none. */
export async function getEntityHealth(orgId: string): Promise<EntityHealth> {
  const [weeks, issues, rocks] = await Promise.all([
    getRecentWeeks(orgId, 12),
    getOrgIssues(orgId),
    getOrgRocks(orgId),
  ]);
  const rows = await getOrgScorecard(
    orgId,
    weeks.map((w) => w.id),
  );

  const lastIndex = weeks.length - 1;
  const lastWeekId = weeks[lastIndex]?.id ?? null;

  let onTrack = 0;
  let critical = 0;
  let watch = 0;
  let missing = 0;

  for (const row of rows) {
    const current = lastWeekId
      ? parseNumeric(row.entriesByWeek[lastWeekId]?.actual)
      : null;
    if (current === null) {
      missing += 1;
      continue;
    }
    const priors: ShadingEntry[] = weeks.slice(0, lastIndex).map((w) => ({
      actual: parseNumeric(row.entriesByWeek[w.id]?.actual),
      noteClassification:
        (row.entriesByWeek[w.id]?.noteClassification as NoteClassification | null) ??
        null,
      statusOverride:
        (row.entriesByWeek[w.id]?.statusOverride as StatusColor | null) ?? null,
    }));
    const entry = lastWeekId ? row.entriesByWeek[lastWeekId] : undefined;
    const result = computeStatus(
      {
        actual: current,
        noteClassification: entry?.noteClassification as NoteClassification | null,
        statusOverride: entry?.statusOverride as StatusColor | null,
      },
      {
        goalDirection: row.measurable.goalDirection as GoalDirection,
        goalValue: parseNumeric(row.measurable.goalValue),
        goalSecondary: parseNumeric(row.measurable.goalSecondary),
      },
      priors,
    );
    if (result.status === "red") critical += 1;
    else if (result.status === "yellow") watch += 1;
    else onTrack += 1;
  }

  const rocksOff = rocks.filter((r) => r.rock.status === "off_track").length;
  const rocksOn = rocks.filter(
    (r) => r.rock.status === "on_track" || r.rock.status === "still_going",
  ).length;

  const signal: StatusColor =
    critical > 0 || rocksOff > 0
      ? "red"
      : watch > 0 || missing > 0
        ? "yellow"
        : "green";

  return {
    total: rows.length,
    onTrack,
    critical,
    watch,
    missing,
    openIssues: issues.length,
    rocksOn,
    rocksOff,
    signal,
  };
}
