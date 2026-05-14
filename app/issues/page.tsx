import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgIssues } from "@/lib/queries/org-lists";
import { IssueActionButtons } from "@/components/issue-action-buttons";
import { IssueNotesEditor } from "@/components/issue-notes-editor";
import { cn } from "@/lib/utils";

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

  const rows = await getOrgIssues(ctx.orgId);
  const counts = rows.reduce(
    (acc, r) => {
      acc[r.issue.status as "open" | "ids_in_progress"] += 1;
      return acc;
    },
    { open: 0, ids_in_progress: 0 },
  );

  return (
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgName} · Issues
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Issues list</h1>
        <p className="text-sm text-muted-foreground">
          Worked / push next week / resolved. Critical first.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-card px-4 py-3 text-sm">
        <Pill color="amber" label={`${counts.ids_in_progress} worked`} />
        <Pill color="muted" label={`${counts.open} push next week`} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No open issues for this org.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Issue</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Notes</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ issue, owner }) => {
                const isOwner = issue.ownerId === ctx.personId;
                const readOnly =
                  ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
                return (
                  <tr key={issue.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-medium">{issue.title}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {owner?.name ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <PriorityChip priority={issue.priority} />
                    </td>
                    <td className="px-3 py-2 min-w-[18rem]">
                      <IssueNotesEditor
                        issueId={issue.id}
                        value={issue.rootCause}
                        readOnly={readOnly}
                      />
                    </td>
                    <td className="px-3 py-2 min-w-[16rem]">
                      <IssueActionButtons
                        issueId={issue.id}
                        status={issue.status as "open" | "ids_in_progress"}
                        readOnly={readOnly}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const DOT_STYLES: Record<"amber" | "muted", string> = {
  amber: "bg-amber-400",
  muted: "bg-muted-foreground/40",
};

function Pill({
  color,
  label,
}: {
  color: "amber" | "muted";
  label: string;
}) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
      <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])} aria-hidden />
      {label}
    </span>
  );
}

const PRIORITY_TAG_STYLES: Record<
  "critical" | "high" | "medium" | "low",
  string
> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-100",
  high: "border-amber-500/40 bg-amber-500/10 text-amber-100",
  medium: "border-border bg-muted/30 text-muted-foreground",
  low: "border-border bg-muted/20 text-muted-foreground",
};

function PriorityChip({
  priority,
}: {
  priority: "critical" | "high" | "medium" | "low";
}) {
  return (
    <span
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        PRIORITY_TAG_STYLES[priority],
      )}
    >
      {priority}
    </span>
  );
}
