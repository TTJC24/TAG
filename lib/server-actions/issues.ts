"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { issues, todos } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import { authorizeWrite, AuthorizationError } from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";
import type { ActionResult } from "@/lib/server-actions/measurables";

function revalidateIssues() {
  revalidatePath("/me");
  revalidatePath("/issues");
  revalidatePath("/admin/readiness");
}

// User-facing issue state (one of three actions on the Issues tab):
//   "worked"   → mark as ids_in_progress
//   "push"     → mark as open (still on the list, needs to push to next week)
//   "resolved" → close out
type IssueAction = "worked" | "push" | "resolved";

const ACTION_TO_STATUS: Record<
  IssueAction,
  "open" | "ids_in_progress" | "resolved"
> = {
  worked: "ids_in_progress",
  push: "open",
  resolved: "resolved",
};

export interface UpdateIssueStatusInput {
  issueId: string;
  action: IssueAction;
}

export async function updateIssueStatus(
  input: UpdateIssueStatusInput,
): Promise<ActionResult<{ issueId: string; status: string }>> {
  try {
    const ctx = await getAuthContext();
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1);
    if (!issue) return { ok: false, error: "issue not found" };
    authorizeWrite(ctx, { orgId: issue.orgId, ownerId: issue.ownerId });

    const nextStatus = ACTION_TO_STATUS[input.action];
    const before = { status: issue.status, resolvedAt: issue.resolvedAt };
    const now = new Date();

    await db
      .update(issues)
      .set({
        status: nextStatus,
        resolvedAt:
          nextStatus === "resolved" ? (issue.resolvedAt ?? now) : null,
      })
      .where(eq(issues.id, issue.id));

    await writeAuditEntry({
      orgId: issue.orgId,
      personId: ctx.personId,
      action: `issue_${input.action}`,
      entityType: "issue",
      entityId: issue.id,
      before,
      after: { status: nextStatus },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "issue-updated",
      issueId: issue.id,
    });

    revalidateIssues();
    return { ok: true, data: { issueId: issue.id, status: nextStatus } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpdateIssueNotesInput {
  issueId: string;
  /** Stored on `issues.rootCause` — schema's existing notes-shaped column. */
  notes: string | null;
}

export async function updateIssueNotes(
  input: UpdateIssueNotesInput,
): Promise<ActionResult<{ issueId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1);
    if (!issue) return { ok: false, error: "issue not found" };
    authorizeWrite(ctx, { orgId: issue.orgId, ownerId: issue.ownerId });

    const before = { rootCause: issue.rootCause };
    const trimmed = input.notes?.trim() ?? null;
    const value = trimmed && trimmed.length > 0 ? trimmed : null;
    await db
      .update(issues)
      .set({ rootCause: value })
      .where(eq(issues.id, issue.id));

    await writeAuditEntry({
      orgId: issue.orgId,
      personId: ctx.personId,
      action: "update_issue_notes",
      entityType: "issue",
      entityId: issue.id,
      before,
      after: { rootCause: value },
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "issue-updated",
      issueId: issue.id,
    });

    revalidateIssues();
    return { ok: true, data: { issueId: issue.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CRUD on issues. createIssue + updateIssue + deleteIssue.
// ─────────────────────────────────────────────────────────────────────────

export interface CreateIssueInput {
  title: string;
  ownerId: string;
  priority?: "critical" | "high" | "medium" | "low";
  rootCause?: string | null;
}

export async function createIssue(
  input: CreateIssueInput,
): Promise<ActionResult<{ issueId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role === "viewer") {
      return { ok: false, error: "forbidden: viewer cannot write" };
    }
    const title = input.title.trim();
    if (!title) return { ok: false, error: "title required" };

    const [inserted] = await db
      .insert(issues)
      .values({
        orgId: ctx.orgId,
        title,
        ownerId: input.ownerId,
        priority: input.priority ?? "medium",
        rootCause: input.rootCause?.trim() ? input.rootCause.trim() : null,
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
      after: { title, ownerId: input.ownerId, priority: input.priority ?? "medium" },
      source: "manual",
    });
    revalidateIssues();
    return { ok: true, data: { issueId: inserted!.id } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UpdateIssueInput {
  issueId: string;
  title?: string;
  ownerId?: string;
  priority?: "critical" | "high" | "medium" | "low";
  rootCause?: string | null;
}

export async function updateIssue(
  input: UpdateIssueInput,
): Promise<ActionResult<{ issueId: string }>> {
  try {
    const ctx = await getAuthContext();
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1);
    if (!issue) return { ok: false, error: "issue not found" };
    authorizeWrite(ctx, { orgId: issue.orgId, ownerId: issue.ownerId });

    const next: Partial<typeof issues.$inferInsert> = {};
    if (input.title !== undefined) {
      const t = input.title.trim();
      if (!t) return { ok: false, error: "title required" };
      next.title = t;
    }
    if (input.ownerId !== undefined) next.ownerId = input.ownerId;
    if (input.priority !== undefined) next.priority = input.priority;
    if (input.rootCause !== undefined) {
      const t = input.rootCause?.trim() ?? "";
      next.rootCause = t.length > 0 ? t : null;
    }

    if (Object.keys(next).length === 0) {
      return { ok: true, data: { issueId: issue.id } };
    }

    await db.update(issues).set(next).where(eq(issues.id, issue.id));

    await writeAuditEntry({
      orgId: issue.orgId,
      personId: ctx.personId,
      action: "update_issue",
      entityType: "issue",
      entityId: issue.id,
      before: {
        title: issue.title,
        ownerId: issue.ownerId,
        priority: issue.priority,
        rootCause: issue.rootCause,
      },
      after: next,
      source: "manual",
    });
    await broadcastScorecard(ctx.clerkOrgId, {
      kind: "issue-updated",
      issueId: issue.id,
    });
    revalidateIssues();
    return { ok: true, data: { issueId: issue.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hard delete — admin only. Nullifies todos.parent_issue_id on any
 *  child to-dos so the FK doesn't block. */
export async function deleteIssue(
  issueId: string,
): Promise<ActionResult<{ issueId: string }>> {
  try {
    const ctx = await getAuthContext();
    if (ctx.role !== "admin") {
      return { ok: false, error: "forbidden: admin only" };
    }
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) return { ok: false, error: "issue not found" };
    if (issue.orgId !== ctx.orgId) {
      return { ok: false, error: "forbidden: wrong org" };
    }

    // Clear FK pointers on dependent to-dos so the delete succeeds.
    await db
      .update(todos)
      .set({ parentIssueId: null })
      .where(eq(todos.parentIssueId, issueId));

    await db.delete(issues).where(eq(issues.id, issueId));

    await writeAuditEntry({
      orgId: issue.orgId,
      personId: ctx.personId,
      action: "delete_issue",
      entityType: "issue",
      entityId: issueId,
      before: {
        title: issue.title,
        ownerId: issue.ownerId,
        priority: issue.priority,
        status: issue.status,
      },
      after: null,
      source: "manual",
    });
    revalidateIssues();
    return { ok: true, data: { issueId } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Quiet unused-imports during transitional dev.
void sql;
