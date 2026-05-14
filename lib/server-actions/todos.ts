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
    revalidatePath("/todos");
    revalidatePath("/admin/readiness");
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

export interface UpdateTodoNotesInput {
  todoId: string;
  notes: string | null;
}

export async function updateTodoNotes(
  input: UpdateTodoNotesInput,
): Promise<ActionResult<{ todoId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, input.todoId))
      .limit(1);
    if (!todo) return { ok: false, error: "to-do not found" };
    authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

    const before = { notes: todo.notes };
    const trimmed = input.notes?.trim() ?? null;
    const value = trimmed && trimmed.length > 0 ? trimmed : null;
    await db.update(todos).set({ notes: value }).where(eq(todos.id, todo.id));

    await writeAuditEntry({
      orgId: todo.orgId,
      personId: ctx.personId,
      action: "update_todo_notes",
      entityType: "todo",
      entityId: todo.id,
      before,
      after: { notes: value },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "todo-updated",
      todoId: todo.id,
    });

    revalidatePath("/me");
    revalidatePath("/todos");
    revalidatePath("/admin/readiness");
    return { ok: true, data: { todoId: todo.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RolloverTodoInput {
  todoId: string;
}

/** Carry a to-do forward: status → rolled_over, rolloverCount += 1, push
 *  due date by 7 days (or set to today + 7 if currently null). Idempotent
 *  in the sense that re-firing keeps incrementing — meant to be triggered
 *  from a "carry forward" button per use, not in a loop. */
export async function rolloverTodo(
  input: RolloverTodoInput,
): Promise<ActionResult<{ todoId: string; rolloverCount: number }>> {
  try {
    const ctx = await getAuthContext();
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, input.todoId))
      .limit(1);
    if (!todo) return { ok: false, error: "to-do not found" };
    authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

    const before = {
      status: todo.status,
      dueDate: todo.dueDate,
      rolloverCount: todo.rolloverCount,
    };
    const baseDate = todo.dueDate ? new Date(todo.dueDate) : new Date();
    const nextDate = new Date(baseDate);
    nextDate.setDate(nextDate.getDate() + 7);
    const nextDueDate = nextDate.toISOString().slice(0, 10);
    const nextRollover = todo.rolloverCount + 1;

    await db
      .update(todos)
      .set({
        status: "rolled_over",
        dueDate: nextDueDate,
        rolloverCount: nextRollover,
      })
      .where(eq(todos.id, todo.id));

    await writeAuditEntry({
      orgId: todo.orgId,
      personId: ctx.personId,
      action: "rollover_todo",
      entityType: "todo",
      entityId: todo.id,
      before,
      after: {
        status: "rolled_over",
        dueDate: nextDueDate,
        rolloverCount: nextRollover,
      },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "todo-updated",
      todoId: todo.id,
    });

    revalidateTodos();
    return { ok: true, data: { todoId: todo.id, rolloverCount: nextRollover } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD on to-dos. createTodo + updateTodo + deleteTodo (soft via 'dropped').
// Members may create / edit own / drop own. Admin may do anything in org.
// ─────────────────────────────────────────────────────────────────────────

function revalidateTodos() {
  revalidatePath("/me");
  revalidatePath("/scorecard");
  revalidatePath("/todos");
  revalidatePath("/admin/readiness");
}

export interface CreateTodoInput {
  description: string;
  ownerId: string;
  dueDate?: string | null;
  notes?: string | null;
}

export async function createTodo(
  input: CreateTodoInput,
): Promise<ActionResult<{ todoId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role === "viewer") {
      return { ok: false, error: "forbidden: viewer cannot write" };
    }
    const description = input.description.trim();
    if (!description) return { ok: false, error: "description required" };

    const [inserted] = await db
      .insert(todos)
      .values({
        orgId: ctx.orgId,
        description,
        ownerId: input.ownerId,
        dueDate: input.dueDate ?? null,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        status: "open",
      })
      .returning({ id: todos.id });

    await writeAuditEntry({
      orgId: ctx.orgId,
      personId: ctx.personId,
      action: "create_todo",
      entityType: "todo",
      entityId: inserted!.id,
      before: null,
      after: { description, ownerId: input.ownerId, dueDate: input.dueDate ?? null },
      source: "manual",
    });
    revalidateTodos();
    return { ok: true, data: { todoId: inserted!.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpdateTodoInput {
  todoId: string;
  description?: string;
  ownerId?: string;
  dueDate?: string | null;
  notes?: string | null;
}

export async function updateTodo(
  input: UpdateTodoInput,
): Promise<ActionResult<{ todoId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, input.todoId))
      .limit(1);
    if (!todo) return { ok: false, error: "to-do not found" };
    authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

    const next: Partial<typeof todos.$inferInsert> = {};
    if (input.description !== undefined) {
      const t = input.description.trim();
      if (!t) return { ok: false, error: "description required" };
      next.description = t;
    }
    if (input.ownerId !== undefined) next.ownerId = input.ownerId;
    if (input.dueDate !== undefined) next.dueDate = input.dueDate ?? null;
    if (input.notes !== undefined) {
      const t = input.notes?.trim() ?? "";
      next.notes = t.length > 0 ? t : null;
    }

    if (Object.keys(next).length === 0) {
      return { ok: true, data: { todoId: todo.id } };
    }

    await db.update(todos).set(next).where(eq(todos.id, todo.id));

    await writeAuditEntry({
      orgId: todo.orgId,
      personId: ctx.personId,
      action: "update_todo",
      entityType: "todo",
      entityId: todo.id,
      before: {
        description: todo.description,
        ownerId: todo.ownerId,
        dueDate: todo.dueDate,
        notes: todo.notes,
      },
      after: next,
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "todo-updated",
      todoId: todo.id,
    });
    revalidateTodos();
    return { ok: true, data: { todoId: todo.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Soft-close: status → "dropped". Disappears from open lists; preserved
 *  in audit + the row stays in the DB for reference. */
export async function deleteTodo(
  todoId: string,
): Promise<ActionResult<{ todoId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [todo] = await db
      .select()
      .from(todos)
      .where(eq(todos.id, todoId))
      .limit(1);
    if (!todo) return { ok: false, error: "to-do not found" };
    authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

    await db
      .update(todos)
      .set({ status: "dropped" })
      .where(eq(todos.id, todoId));

    await writeAuditEntry({
      orgId: todo.orgId,
      personId: ctx.personId,
      action: "drop_todo",
      entityType: "todo",
      entityId: todoId,
      before: { status: todo.status },
      after: { status: "dropped" },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "todo-updated",
      todoId,
    });
    revalidateTodos();
    return { ok: true, data: { todoId } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
