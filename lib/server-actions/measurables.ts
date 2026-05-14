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

    revalidatePath("/me");
    revalidatePath("/scorecard");
    revalidatePath("/admin/readiness");
    return { ok: true, data: { entryId } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
