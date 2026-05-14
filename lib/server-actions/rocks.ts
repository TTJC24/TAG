"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { rocks, type Rock } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import { authorizeWrite, AuthorizationError } from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";
import type { ActionResult } from "@/lib/server-actions/measurables";

type RockStatus = "on_track" | "off_track" | "completed" | "still_going";

export interface UpdateRockStatusInput {
  rockId: string;
  status: RockStatus;
  note?: string | null;
}

interface StatusHistoryRow {
  date: string;
  status: RockStatus;
  note: string | null;
  changedByPersonId: string;
}

export async function updateRockStatus(
  input: UpdateRockStatusInput,
): Promise<ActionResult<{ rockId: string }>> {
  try {
    const ctx = await getAuthContext();

    const [rock] = await db
      .select()
      .from(rocks)
      .where(eq(rocks.id, input.rockId))
      .limit(1);
    if (!rock) return { ok: false, error: "rock not found" };

    authorizeWrite(ctx, { orgId: rock.orgId, ownerId: rock.ownerId });

    const now = new Date();
    const history = (rock.statusHistory as StatusHistoryRow[] | null) ?? [];
    const appended: StatusHistoryRow[] = [
      ...history,
      {
        date: now.toISOString(),
        status: input.status,
        note: input.note ?? null,
        changedByPersonId: ctx.personId,
      },
    ];

    const before: Pick<Rock, "status" | "statusHistory" | "completedAt"> = {
      status: rock.status,
      statusHistory: rock.statusHistory,
      completedAt: rock.completedAt,
    };

    await db
      .update(rocks)
      .set({
        status: input.status,
        statusHistory: appended,
        completedAt:
          input.status === "completed" ? (rock.completedAt ?? now) : null,
      })
      .where(eq(rocks.id, input.rockId));

    await writeAuditEntry({
      orgId: rock.orgId,
      personId: ctx.personId,
      action: "update_rock_status",
      entityType: "rock",
      entityId: rock.id,
      before,
      after: { status: input.status, note: input.note ?? null },
      source: "manual",
    });

    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "rock-updated",
      rockId: rock.id,
    });

    revalidatePath("/me");
    revalidatePath("/scorecard");
    revalidatePath("/rocks");
    revalidatePath("/admin/readiness");
    return { ok: true, data: { rockId: rock.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export interface UpdateRockNotesInput {
  rockId: string;
  notes: string | null;
}

export async function updateRockNotes(
  input: UpdateRockNotesInput,
): Promise<ActionResult<{ rockId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [rock] = await db
      .select()
      .from(rocks)
      .where(eq(rocks.id, input.rockId))
      .limit(1);
    if (!rock) return { ok: false, error: "rock not found" };
    authorizeWrite(ctx, { orgId: rock.orgId, ownerId: rock.ownerId });

    const before = { notes: rock.notes };
    const trimmed = input.notes?.trim() ?? null;
    await db
      .update(rocks)
      .set({ notes: trimmed && trimmed.length > 0 ? trimmed : null })
      .where(eq(rocks.id, rock.id));

    await writeAuditEntry({
      orgId: rock.orgId,
      personId: ctx.personId,
      action: "update_rock_notes",
      entityType: "rock",
      entityId: rock.id,
      before,
      after: { notes: trimmed },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "rock-updated",
      rockId: rock.id,
    });

    revalidateRocks();
    return { ok: true, data: { rockId: rock.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD on rocks. createRock + updateRock + deleteRock.
// ─────────────────────────────────────────────────────────────────────────

function revalidateRocks() {
  revalidatePath("/me");
  revalidatePath("/scorecard");
  revalidatePath("/rocks");
  revalidatePath("/admin/readiness");
}

export interface CreateRockInput {
  description: string;
  ownerId: string;
  quarter: string;
  dueDate?: string | null;
  status?: RockStatus;
  notes?: string | null;
}

export async function createRock(
  input: CreateRockInput,
): Promise<ActionResult<{ rockId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role !== "admin") {
      return { ok: false, error: "forbidden: admin only" };
    }
    const description = input.description.trim();
    if (!description) return { ok: false, error: "description required" };
    const quarter = input.quarter.trim();
    if (!quarter) return { ok: false, error: "quarter required" };

    const [inserted] = await db
      .insert(rocks)
      .values({
        orgId: ctx.orgId,
        description,
        ownerId: input.ownerId,
        quarter,
        dueDate: input.dueDate ?? null,
        status: input.status ?? "on_track",
        notes: input.notes?.trim() ? input.notes.trim() : null,
      })
      .returning({ id: rocks.id });

    await writeAuditEntry({
      orgId: ctx.orgId,
      personId: ctx.personId,
      action: "create_rock",
      entityType: "rock",
      entityId: inserted!.id,
      before: null,
      after: { description, ownerId: input.ownerId, quarter, status: input.status ?? "on_track" },
      source: "manual",
    });
    revalidateRocks();
    return { ok: true, data: { rockId: inserted!.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpdateRockInput {
  rockId: string;
  description?: string;
  ownerId?: string;
  quarter?: string;
  dueDate?: string | null;
  notes?: string | null;
}

export async function updateRock(
  input: UpdateRockInput,
): Promise<ActionResult<{ rockId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [rock] = await db
      .select()
      .from(rocks)
      .where(eq(rocks.id, input.rockId))
      .limit(1);
    if (!rock) return { ok: false, error: "rock not found" };
    authorizeWrite(ctx, { orgId: rock.orgId, ownerId: rock.ownerId });

    const next: Partial<typeof rocks.$inferInsert> = {};
    if (input.description !== undefined) {
      const t = input.description.trim();
      if (!t) return { ok: false, error: "description required" };
      next.description = t;
    }
    if (input.ownerId !== undefined) next.ownerId = input.ownerId;
    if (input.quarter !== undefined) {
      const q = input.quarter.trim();
      if (!q) return { ok: false, error: "quarter required" };
      next.quarter = q;
    }
    if (input.dueDate !== undefined) next.dueDate = input.dueDate ?? null;
    if (input.notes !== undefined) {
      const t = input.notes?.trim() ?? "";
      next.notes = t.length > 0 ? t : null;
    }

    if (Object.keys(next).length === 0) {
      return { ok: true, data: { rockId: rock.id } };
    }

    await db.update(rocks).set(next).where(eq(rocks.id, rock.id));

    await writeAuditEntry({
      orgId: rock.orgId,
      personId: ctx.personId,
      action: "update_rock",
      entityType: "rock",
      entityId: rock.id,
      before: {
        description: rock.description,
        ownerId: rock.ownerId,
        quarter: rock.quarter,
        dueDate: rock.dueDate,
        notes: rock.notes,
      },
      after: next,
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "rock-updated",
      rockId: rock.id,
    });
    revalidateRocks();
    return { ok: true, data: { rockId: rock.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hard delete — admin only. status_history travels with the row. No FK
 *  dependents (rocks aren't referenced by other tables). */
export async function deleteRock(
  rockId: string,
): Promise<ActionResult<{ rockId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role !== "admin") {
      return { ok: false, error: "forbidden: admin only" };
    }
    const [rock] = await db
      .select()
      .from(rocks)
      .where(eq(rocks.id, rockId))
      .limit(1);
    if (!rock) return { ok: false, error: "rock not found" };
    if (rock.orgId !== ctx.orgId) {
      return { ok: false, error: "forbidden: wrong org" };
    }

    await db.delete(rocks).where(eq(rocks.id, rockId));

    await writeAuditEntry({
      orgId: rock.orgId,
      personId: ctx.personId,
      action: "delete_rock",
      entityType: "rock",
      entityId: rockId,
      before: {
        description: rock.description,
        ownerId: rock.ownerId,
        status: rock.status,
      },
      after: null,
      source: "manual",
    });
    revalidateRocks();
    return { ok: true, data: { rockId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
