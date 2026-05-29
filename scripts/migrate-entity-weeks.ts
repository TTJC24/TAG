// One-time migration to entity-local weeks (ADR-0013).
//
// 1. Sets each org's cadence config.
// 2. Clones the existing GLOBAL (orgId-null) weeks into per-org copies on the
//    SAME dates and repoints that org's entries + week snapshots to the copy —
//    history is preserved exactly (no re-dating); only weeks generated from now
//    on use each entity's weekEndsOn.
// 3. Deletes the orphaned global weeks once nothing references them.
//
// Idempotent: re-running re-sets config and no-ops the clone/repoint/delete
// (the global weeks are gone after the first run).
//
// Run AFTER the schema migration (0004) is applied:
//   pnpm exec tsx --env-file=.env.local scripts/migrate-entity-weeks.ts

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  entries,
  measurables,
  organizations,
  weeks,
  weekSnapshots,
  type WeekDay,
} from "@/lib/db/schema";

interface Cadence {
  weekEndsOn: WeekDay;
  meetingDay: WeekDay;
  entryCutoffDay: WeekDay;
  entryCutoffTime: string;
}

// Keyed by organizations.code. CULTIVUS+ is intentionally absent — no weekly
// cadence (left null). Adjust here if the operator changes a cadence.
const CONFIG: Record<string, Cadence> = {
  FS: { weekEndsOn: "sunday", meetingDay: "monday", entryCutoffDay: "monday", entryCutoffTime: "morning" },
  BL: { weekEndsOn: "thursday", meetingDay: "friday", entryCutoffDay: "thursday", entryCutoffTime: "EOD" },
  USA: { weekEndsOn: "thursday", meetingDay: "friday", entryCutoffDay: "thursday", entryCutoffTime: "EOD" },
};

async function count(table: typeof entries | typeof weekSnapshots, weekIds: string[]): Promise<number> {
  if (weekIds.length === 0) return 0;
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(table)
    .where(inArray(table.weekId, weekIds));
  return Number(row?.c ?? 0);
}

async function main() {
  const orgs = await db
    .select({ id: organizations.id, code: organizations.code, name: organizations.name })
    .from(organizations);
  console.log(`[migrate] orgs: ${orgs.map((o) => `${o.code} (${o.name})`).join(", ")}`);

  // 1) Per-entity cadence config
  for (const o of orgs) {
    const cfg = CONFIG[o.code];
    if (!cfg) {
      console.log(`[migrate]   ${o.code}: no cadence config — left null (manual log)`);
      continue;
    }
    await db.update(organizations).set(cfg).where(eq(organizations.id, o.id));
    console.log(`[migrate]   ${o.code}: weekEndsOn=${cfg.weekEndsOn}, meetingDay=${cfg.meetingDay}, cutoff=${cfg.entryCutoffDay} ${cfg.entryCutoffTime}`);
  }

  // 2) Clone global weeks per-org + repoint entries / snapshots
  const globalWeeks = await db.select().from(weeks).where(isNull(weeks.orgId));
  console.log(`[migrate] global (orgless) weeks: ${globalWeeks.length}`);
  let clones = 0;
  for (const o of orgs) {
    const mids = (
      await db.select({ id: measurables.id }).from(measurables).where(eq(measurables.orgId, o.id))
    ).map((m) => m.id);
    for (const gw of globalWeeks) {
      await db
        .insert(weeks)
        .values({
          orgId: o.id,
          weekEndingDate: gw.weekEndingDate,
          weekNumber: gw.weekNumber,
          quarter: gw.quarter,
          fiscalYear: gw.fiscalYear,
        })
        .onConflictDoNothing({ target: [weeks.orgId, weeks.weekEndingDate] });
      const [clone] = await db
        .select({ id: weeks.id })
        .from(weeks)
        .where(and(eq(weeks.orgId, o.id), eq(weeks.weekEndingDate, gw.weekEndingDate)))
        .limit(1);
      if (!clone) continue;
      clones += 1;
      if (mids.length > 0) {
        await db
          .update(entries)
          .set({ weekId: clone.id })
          .where(and(eq(entries.weekId, gw.id), inArray(entries.measurableId, mids)));
      }
      await db
        .update(weekSnapshots)
        .set({ weekId: clone.id })
        .where(and(eq(weekSnapshots.weekId, gw.id), eq(weekSnapshots.orgId, o.id)));
    }
  }
  console.log(`[migrate] ensured ${clones} per-org week clones`);

  // 3) Guarded delete of orphaned global weeks
  const globalIds = globalWeeks.map((w) => w.id);
  if (globalIds.length > 0) {
    const orphanEntries = await count(entries, globalIds);
    const orphanSnaps = await count(weekSnapshots, globalIds);
    console.log(`[migrate] refs still on global weeks — entries: ${orphanEntries}, snapshots: ${orphanSnaps}`);
    if (orphanEntries === 0 && orphanSnaps === 0) {
      await db.delete(weeks).where(isNull(weeks.orgId));
      console.log(`[migrate] deleted ${globalIds.length} orphaned global weeks`);
    } else {
      console.log(`[migrate] !! orphan references remain — global weeks NOT deleted. Investigate before re-running.`);
    }
  }

  // 4) After report
  const perOrg = await db
    .select({ code: organizations.code, c: sql<number>`count(${weeks.id})::int` })
    .from(weeks)
    .innerJoin(organizations, eq(weeks.orgId, organizations.id))
    .groupBy(organizations.code);
  console.log(`[migrate] per-org weeks: ${perOrg.map((r) => `${r.code}:${r.c}`).join(", ")}`);
  console.log("[migrate] done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
