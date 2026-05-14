"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { entries, measurables } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import { authorizeWrite, AuthorizationError } from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";

export type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function revalidateAll() {
  revalidatePath("/me");
  revalidatePath("/scorecard");
  revalidatePath("/admin/readiness");
}

type GoalDirection =
  | "gte"
  | "lte"
  | "eq"
  | "between"
  | "trend_down"
  | "trend_up";

type Cadence = "weekly" | "monthly";

export interface UpdateActualInput {
  measurableId: string;
  weekId: string;
  /** Pass as a string so the form value flows through unchanged; the action
   *  parses + validates. Pass null/empty to clear the actual. */
  actual: string | null;
  note?: string | null;
}

export async function updateActual(
  input: UpdateActualInput,
): Promise<ActionResult<{ entryId: string }>> {
  try {
    const ctx = await getAuthContext();

    const [m] = await db
      .select()
      .from(measurables)
      .where(eq(measurables.id, input.measurableId))
      .limit(1);
    if (!m) return { ok: false, error: "measurable not found" };

    authorizeWrite(ctx, { orgId: m.orgId, ownerId: m.ownerId });

    // Normalize the actual into a numeric string Postgres can parse. Empty
    // string / null clears the value.
    const trimmed = input.actual?.trim();
    const parsed = trimmed && trimmed.length > 0 ? Number(trimmed) : null;
    if (trimmed && trimmed.length > 0 && !Number.isFinite(parsed)) {
      return { ok: false, error: `"${input.actual}" is not a number` };
    }
    const actualStr = parsed === null ? null : String(parsed);

    // Load any existing entry for the audit before/after diff.
    const [existing] = await db
      .select()
      .from(entries)
      .where(
        and(eq(entries.measurableId, input.measurableId), eq(entries.weekId, input.weekId)),
      )
      .limit(1);

    const noteClassificationReset =
      input.note !== undefined && input.note !== existing?.note;

    let entryId: string;
    if (existing) {
      await db
        .update(entries)
        .set({
          actual: actualStr,
          note: input.note ?? existing.note,
          source: "manual",
          enteredByPersonId: ctx.personId,
          enteredAt: new Date(),
          ...(noteClassificationReset ? { noteClassification: null } : {}),
        })
        .where(eq(entries.id, existing.id));
      entryId = existing.id;
    } else {
      const [inserted] = await db
        .insert(entries)
        .values({
          measurableId: input.measurableId,
          weekId: input.weekId,
          actual: actualStr,
          note: input.note ?? null,
          source: "manual",
          enteredByPersonId: ctx.personId,
        })
        .returning({ id: entries.id });
      entryId = inserted!.id;
    }

    await writeAuditEntry({
      orgId: m.orgId,
      personId: ctx.personId,
      action: "update_actual",
      entityType: "entry",
      entityId: entryId,
      before: existing
        ? { actual: existing.actual, note: existing.note }
        : null,
      after: { actual: actualStr, note: input.note ?? existing?.note ?? null },
      source: "manual",
    });

    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "entry-updated",
      entryId,
      measurableId: input.measurableId,
      weekId: input.weekId,
    });

    revalidateAll();
    return { ok: true, data: { entryId } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD on measurables themselves (not entries). Admin-only.
// ─────────────────────────────────────────────────────────────────────────

function parseGoalNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number`);
  return n;
}

export interface CreateMeasurableInput {
  name: string;
  ownerId: string;
  unit?: string | null;
  formatHint: string; // currency_usd | percent | days | turns | count | currency_usd_trend
  goalDirection: GoalDirection;
  /** Send as string (form values). Empty/null clears. */
  goalValue?: string | null;
  goalSecondary?: string | null;
  cadence: Cadence;
  formula?: string | null;
}

export async function createMeasurable(
  input: CreateMeasurableInput,
): Promise<ActionResult<{ measurableId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role !== "admin") {
      return { ok: false, error: "forbidden: admin only" };
    }
    const name = input.name.trim();
    if (!name) return { ok: false, error: "name required" };

    const goalValue = parseGoalNumber(input.goalValue ?? null);
    const goalSecondary = parseGoalNumber(input.goalSecondary ?? null);

    // displayOrder = max+10
    const all = await db
      .select({ d: measurables.displayOrder })
      .from(measurables)
      .where(eq(measurables.orgId, ctx.orgId));
    const nextOrder =
      all.reduce((m, r) => Math.max(m, r.d ?? 0), 0) + 10;

    const [inserted] = await db
      .insert(measurables)
      .values({
        orgId: ctx.orgId,
        name,
        ownerId: input.ownerId,
        unit: input.unit ?? null,
        formatHint: input.formatHint,
        goalDirection: input.goalDirection,
        goalValue: goalValue !== null ? String(goalValue) : null,
        goalSecondary: goalSecondary !== null ? String(goalSecondary) : null,
        cadence: input.cadence,
        formula: input.formula ?? null,
        displayOrder: nextOrder,
      })
      .returning({ id: measurables.id });

    await writeAuditEntry({
      orgId: ctx.orgId,
      personId: ctx.personId,
      action: "create_measurable",
      entityType: "measurable",
      entityId: inserted!.id,
      before: null,
      after: { name, ownerId: input.ownerId, formatHint: input.formatHint },
      source: "manual",
    });
    revalidateAll();
    return { ok: true, data: { measurableId: inserted!.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpdateMeasurableInput {
  measurableId: string;
  name?: string;
  ownerId?: string;
  unit?: string | null;
  formatHint?: string;
  goalDirection?: GoalDirection;
  goalValue?: string | null;
  goalSecondary?: string | null;
  cadence?: Cadence;
  formula?: string | null;
}

export async function updateMeasurable(
  input: UpdateMeasurableInput,
): Promise<ActionResult<{ measurableId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [m] = await db
      .select()
      .from(measurables)
      .where(eq(measurables.id, input.measurableId))
      .limit(1);
    if (!m) return { ok: false, error: "measurable not found" };
    authorizeWrite(ctx, { orgId: m.orgId, ownerId: m.ownerId });

    const next: Partial<typeof measurables.$inferInsert> = {};
    if (input.name !== undefined) {
      const t = input.name.trim();
      if (!t) return { ok: false, error: "name required" };
      next.name = t;
    }
    if (input.ownerId !== undefined) next.ownerId = input.ownerId;
    if (input.unit !== undefined) next.unit = input.unit ?? null;
    if (input.formatHint !== undefined) next.formatHint = input.formatHint;
    if (input.goalDirection !== undefined) next.goalDirection = input.goalDirection;
    if (input.goalValue !== undefined) {
      const g = parseGoalNumber(input.goalValue);
      next.goalValue = g !== null ? String(g) : null;
    }
    if (input.goalSecondary !== undefined) {
      const g = parseGoalNumber(input.goalSecondary);
      next.goalSecondary = g !== null ? String(g) : null;
    }
    if (input.cadence !== undefined) next.cadence = input.cadence;
    if (input.formula !== undefined) next.formula = input.formula ?? null;

    if (Object.keys(next).length === 0) {
      return { ok: true, data: { measurableId: m.id } };
    }

    await db.update(measurables).set(next).where(eq(measurables.id, m.id));

    await writeAuditEntry({
      orgId: m.orgId,
      personId: ctx.personId,
      action: "update_measurable",
      entityType: "measurable",
      entityId: m.id,
      before: {
        name: m.name,
        ownerId: m.ownerId,
        unit: m.unit,
        formatHint: m.formatHint,
        goalDirection: m.goalDirection,
        goalValue: m.goalValue,
        goalSecondary: m.goalSecondary,
        cadence: m.cadence,
        formula: m.formula,
      },
      after: next,
      source: "manual",
    });
    revalidateAll();
    return { ok: true, data: { measurableId: m.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Soft-archive — sets archivedAt. List queries filter archivedAt IS NULL.
 *  Preserves historical entries (they remain queryable). Admin-only. */
export async function archiveMeasurable(
  measurableId: string,
): Promise<ActionResult<{ measurableId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role !== "admin") {
      return { ok: false, error: "forbidden: admin only" };
    }
    const [m] = await db
      .select()
      .from(measurables)
      .where(eq(measurables.id, measurableId))
      .limit(1);
    if (!m) return { ok: false, error: "measurable not found" };
    if (m.orgId !== ctx.orgId) {
      return { ok: false, error: "forbidden: wrong org" };
    }
    if (m.archivedAt) {
      return { ok: true, data: { measurableId } };
    }
    await db
      .update(measurables)
      .set({ archivedAt: new Date() })
      .where(eq(measurables.id, measurableId));

    await writeAuditEntry({
      orgId: m.orgId,
      personId: ctx.personId,
      action: "archive_measurable",
      entityType: "measurable",
      entityId: measurableId,
      before: { archivedAt: m.archivedAt },
      after: { archivedAt: new Date().toISOString() },
      source: "manual",
    });
    revalidateAll();
    return { ok: true, data: { measurableId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
