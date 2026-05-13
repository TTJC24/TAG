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

type RockStatus = "on_track" | "off_track" | "completed";

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
    return { ok: true, data: { rockId: rock.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
