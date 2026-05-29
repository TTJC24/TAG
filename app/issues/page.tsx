import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgIssues } from "@/lib/queries/org-lists";
import { AddIssueButton } from "@/components/issue-dialogs";
import { Eyebrow } from "@/components/ui/primitives";
import { IssueQueue } from "./issue-queue";

export const dynamic = "force-dynamic";

export default async function IssuesPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  const [rows, members] = await Promise.all([
    getOrgIssues(ctx.orgId),
    getOrgMembers(ctx.orgId),
  ]);
  const canCreate = ctx.role !== "viewer";
  const isAdmin = ctx.role === "admin";

  // Surface metrics — derived only, no reordering of server-sorted rows.
  const counts = rows.reduce(
    (acc, r) => {
      acc.open += 1;
      acc[r.issue.priority] += 1;
      return acc;
    },
    { open: 0, critical: 0, high: 0, medium: 0, low: 0 },
  );

  // Per-row access flags are resolved here so the client list stays presentational.
  const items = rows.map(({ issue, owner }) => {
    const isOwner = issue.ownerId === ctx.personId;
    const readOnly =
      ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
    return {
      id: issue.id,
      title: issue.title,
      status: issue.status as "open" | "ids_in_progress",
      priority: issue.priority,
      rootCause: issue.rootCause,
      ownerId: issue.ownerId,
      ownerName: owner?.name ?? null,
      readOnly,
    };
  });

  return (
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · Issues</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">IDS queue</h1>
        </div>
        {canCreate && (
          <AddIssueButton members={members} defaultOwnerId={ctx.personId} />
        )}
      </header>

      <IssueQueue
        items={items}
        members={members}
        counts={counts}
        canDelete={isAdmin}
      />
    </main>
  );
}
