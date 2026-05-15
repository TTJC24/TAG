"use server";

// Apply approved Jerry action intents to the canonical Postgres state.
// Dispatches each intent kind to a matching DB write; every write is
// permission-checked through the same authorizeWrite contract used by
// manual actions, then audited with source: "jerry" so Jerry-attributed
// changes are distinguishable in the audit log.
//
// Wire path: Jerry returns one or more JerryActionIntent items in a
// JerryResponse. The dock surfaces each intent with Approve/Skip. Each
// approved intent posts to /api/jerry/apply, which calls applyIntent().

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import {
  entries,
  issues,
  measurables,
  rocks,
  todos,
} from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import {
  authorizeWrite,
  AuthorizationError,
} from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";
import type { JerryActionIntent } from "./types";

export type ApplyResult =
  | { ok: true; entityId: string }
  | { ok: false; error: string };

function revalidateAll() {
  revalidatePath("/me");
  revalidatePath("/scorecard");
  revalidatePath("/rocks");
  revalidatePath("/todos");
  revalidatePath("/issues");
  revalidatePath("/admin/readiness");
}

export async function applyIntent(intent: JerryActionIntent): Promise<ApplyResult> {
  try {
    const ctx = await getAuthContext();
    switch (intent.kind) {
      case "update_actual":
        return await applyUpdateActual(ctx, intent);
      case "update_rock_status":
        return await applyUpdateRockStatus(ctx, intent);
      case "set_todo_done":
        return await applySetTodoDone(ctx, intent);
      case "update_issue_status":
        return await applyUpdateIssueStatus(ctx, intent);
      case "create_todo":
        return await applyCreateTodo(ctx, intent);
      case "create_issue":
        return await applyCreateIssue(ctx, intent);
    }
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── update_actual ─────────────────────────────────────────────────────────────

async function applyUpdateActual(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "update_actual" }>,
): Promise<ApplyResult> {
  const [m] = await db
    .select()
    .from(measurables)
    .where(eq(measurables.id, intent.measurableId))
    .limit(1);
  if (!m) return { ok: false, error: "measurable not found" };
  authorizeWrite(ctx, { orgId: m.orgId, ownerId: m.ownerId });

  const trimmed = intent.actual?.trim() ?? "";
  const parsed = trimmed.length > 0 ? Number(trimmed) : null;
  if (trimmed.length > 0 && !Number.isFinite(parsed)) {
    return { ok: false, error: `"${intent.actual}" is not a number` };
  }
  const actualStr = parsed === null ? null : String(parsed);

  const [existing] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.measurableId, intent.measurableId),
        eq(entries.weekId, intent.weekId),
      ),
    )
    .limit(1);

  let entryId: string;
  if (existing) {
    await db
      .update(entries)
      .set({
        actual: actualStr,
        note: intent.note ?? existing.note,
        source: "jerry",
        enteredByPersonId: ctx.personId,
        enteredAt: new Date(),
      })
      .where(eq(entries.id, existing.id));
    entryId = existing.id;
  } else {
    const [inserted] = await db
      .insert(entries)
      .values({
        measurableId: intent.measurableId,
        weekId: intent.weekId,
        actual: actualStr,
        note: intent.note ?? null,
        source: "jerry",
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
    before: existing ? { actual: existing.actual, note: existing.note } : null,
    after: { actual: actualStr, note: intent.note ?? existing?.note ?? null },
    source: "jerry",
  });
  await broadcastScorecard(ctx.clerkOrgId, {
    kind: "entry-updated",
    entryId,
    measurableId: intent.measurableId,
    weekId: intent.weekId,
  });
  revalidateAll();
  return { ok: true, entityId: entryId };
}

// ── update_rock_status ───────────────────────────────────────────────────────

async function applyUpdateRockStatus(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "update_rock_status" }>,
): Promise<ApplyResult> {
  const [rock] = await db
    .select()
    .from(rocks)
    .where(eq(rocks.id, intent.rockId))
    .limit(1);
  if (!rock) return { ok: false, error: "rock not found" };
  authorizeWrite(ctx, { orgId: rock.orgId, ownerId: rock.ownerId });

  const now = new Date();
  type StatusHistoryRow = {
    date: string;
    status: string;
    note: string | null;
    changedByPersonId: string;
    via?: string;
  };
  const history = (rock.statusHistory as StatusHistoryRow[] | null) ?? [];
  const appended: StatusHistoryRow[] = [
    ...history,
    {
      date: now.toISOString(),
      status: intent.status,
      note: intent.note ?? null,
      changedByPersonId: ctx.personId,
      via: "jerry",
    },
  ];

  await db
    .update(rocks)
    .set({
      status: intent.status,
      statusHistory: appended,
      completedAt:
        intent.status === "completed" ? (rock.completedAt ?? now) : null,
    })
    .where(eq(rocks.id, rock.id));

  await writeAuditEntry({
    orgId: rock.orgId,
    personId: ctx.personId,
    action: "update_rock_status",
    entityType: "rock",
    entityId: rock.id,
    before: { status: rock.status },
    after: { status: intent.status, note: intent.note ?? null },
    source: "jerry",
  });
  await broadcastScorecard(ctx.clerkOrgId, {
    kind: "rock-updated",
    rockId: rock.id,
  });
  revalidateAll();
  return { ok: true, entityId: rock.id };
}

// ── set_todo_done ────────────────────────────────────────────────────────────

async function applySetTodoDone(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "set_todo_done" }>,
): Promise<ApplyResult> {
  const [todo] = await db
    .select()
    .from(todos)
    .where(eq(todos.id, intent.todoId))
    .limit(1);
  if (!todo) return { ok: false, error: "todo not found" };
  authorizeWrite(ctx, { orgId: todo.orgId, ownerId: todo.ownerId });

  const now = new Date();
  await db
    .update(todos)
    .set({
      status: intent.done ? "done" : "open",
      completedAt: intent.done ? (todo.completedAt ?? now) : null,
    })
    .where(eq(todos.id, todo.id));

  await writeAuditEntry({
    orgId: todo.orgId,
    personId: ctx.personId,
    action: intent.done ? "complete_todo" : "reopen_todo",
    entityType: "todo",
    entityId: todo.id,
    before: { status: todo.status },
    after: { status: intent.done ? "done" : "open" },
    source: "jerry",
  });
  await broadcastScorecard(ctx.clerkOrgId, {
    kind: "todo-updated",
    todoId: todo.id,
  });
  revalidateAll();
  return { ok: true, entityId: todo.id };
}

// ── update_issue_status ──────────────────────────────────────────────────────

const ISSUE_ACTION_TO_STATUS: Record<
  "worked" | "push" | "resolved",
  "open" | "ids_in_progress" | "resolved"
> = {
  worked: "ids_in_progress",
  push: "open",
  resolved: "resolved",
};

async function applyUpdateIssueStatus(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "update_issue_status" }>,
): Promise<ApplyResult> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, intent.issueId))
    .limit(1);
  if (!issue) return { ok: false, error: "issue not found" };
  authorizeWrite(ctx, { orgId: issue.orgId, ownerId: issue.ownerId });

  const next = ISSUE_ACTION_TO_STATUS[intent.action];
  const now = new Date();
  await db
    .update(issues)
    .set({
      status: next,
      resolvedAt: next === "resolved" ? (issue.resolvedAt ?? now) : null,
    })
    .where(eq(issues.id, issue.id));

  await writeAuditEntry({
    orgId: issue.orgId,
    personId: ctx.personId,
    action: `issue_${intent.action}`,
    entityType: "issue",
    entityId: issue.id,
    before: { status: issue.status },
    after: { status: next },
    source: "jerry",
  });
  await broadcastScorecard(ctx.clerkOrgId, {
    kind: "issue-updated",
    issueId: issue.id,
  });
  revalidateAll();
  return { ok: true, entityId: issue.id };
}

// ── create_todo ──────────────────────────────────────────────────────────────

async function applyCreateTodo(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "create_todo" }>,
): Promise<ApplyResult> {
  if (ctx.role === "viewer") return { ok: false, error: "forbidden: viewer" };
  const desc = intent.description.trim();
  if (!desc) return { ok: false, error: "description required" };

  const [inserted] = await db
    .insert(todos)
    .values({
      orgId: ctx.orgId,
      description: desc,
      ownerId: intent.ownerId,
      dueDate: intent.dueDate ?? null,
      notes: intent.notes?.trim() ? intent.notes.trim() : null,
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
    after: { description: desc, ownerId: intent.ownerId, dueDate: intent.dueDate ?? null },
    source: "jerry",
  });
  revalidateAll();
  return { ok: true, entityId: inserted!.id };
}

// ── create_issue ─────────────────────────────────────────────────────────────

async function applyCreateIssue(
  ctx: Awaited<ReturnType<typeof getAuthContext>>,
  intent: Extract<JerryActionIntent, { kind: "create_issue" }>,
): Promise<ApplyResult> {
  if (ctx.role === "viewer") return { ok: false, error: "forbidden: viewer" };
  const title = intent.title.trim();
  if (!title) return { ok: false, error: "title required" };

  const [inserted] = await db
    .insert(issues)
    .values({
      orgId: ctx.orgId,
      title,
      ownerId: intent.ownerId,
      priority: intent.priority ?? "medium",
      rootCause: intent.rootCause?.trim() ? intent.rootCause.trim() : null,
      status: "open",
    })
    .returning({ id: issues.id });

  await writeAuditEntry({
    orgId: ctx.orgId,
    personId: ctx.personId,
    action: "create_issue",
    entityType: "issue",
    entityId: inserted!.id,
    before: null,
    after: { title, ownerId: intent.ownerId, priority: intent.priority ?? "medium" },
    source: "jerry",
  });
  revalidateAll();
  return { ok: true, entityId: inserted!.id };
}
