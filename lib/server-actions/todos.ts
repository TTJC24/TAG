"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { todos } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import { authorizeWrite, AuthorizationError } from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";
import type { ActionResult } from "@/lib/server-actions/measurables";

export interface CompleteTodoInput {
  todoId: string;
  /** When undefined, action toggles between done and open. */
  done?: boolean;
}

export async function setTodoDone(
  input: CompleteTodoInput,
): Promise<ActionResult<{ todoId: string; status: string }>> {
  try {
    const ctx = await getAuthContext();
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, input.todoId))
      .limit(1);
    if (!todo) return { ok: false, error: "to-do not found" };

    authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

    const wantDone = input.done ?? todo.status !== "done";
    const before = { status: todo.status, completedAt: todo.completedAt };
    const now = new Date();

    await db
      .update(todos)
      .set({
        status: wantDone ? "done" : "open",
        completedAt: wantDone ? (todo.completedAt ?? now) : null,
      })
      .where(eq(todos.id, todo.id));

    await writeAuditEntry({
      orgId: todo.orgId,
      personId: ctx.personId,
      action: wantDone ? "complete_todo" : "reopen_todo",
      entityType: "todo",
      entityId: todo.id,
      before,
      after: { status: wantDone ? "done" : "open" },
      source: "manual",
    });

    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "todo-updated",
      todoId: todo.id,
    });

    revalidatePath("/me");
    revalidatePath("/scorecard");
    return {
      ok: true,
      data: { todoId: todo.id, status: wantDone ? "done" : "open" },
    };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
