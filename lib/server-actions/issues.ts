"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { issues } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/context";
import { authorizeWrite, AuthorizationError } from "@/lib/server-actions/authorize";
import { writeAuditEntry } from "@/lib/audit/log";
import { broadcastScorecard } from "@/lib/realtime/broadcast";
import type { ActionResult } from "@/lib/server-actions/measurables";

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

    revalidatePath("/me");
    revalidatePath("/issues");
    revalidatePath("/admin/readiness");
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

    revalidatePath("/me");
    revalidatePath("/issues");
    revalidatePath("/admin/readiness");
    return { ok: true, data: { issueId: issue.id } };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, error: `forbidden: ${err.reason}` };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
