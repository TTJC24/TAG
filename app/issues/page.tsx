import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getOrgIssues } from "@/lib/queries/org-lists";
import { IssueActionButtons } from "@/components/issue-action-buttons";
import { IssueNotesEditor } from "@/components/issue-notes-editor";
import {
  Eyebrow,
  OwnerChip,
  Panel,
  PanelHeader,
  StatusChip,
} from "@/components/ui/primitives";
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
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · Issues</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">IDS queue</h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <Pill tone="amber" label={`${counts.ids_in_progress} worked`} />
          <Pill tone="muted" label={`${counts.open} push next week`} />
        </div>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No open issues for this org.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader title="Issue" count={rows.length} hint="critical first" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <Th className="pl-4">Issue</Th>
                  <Th>Owner</Th>
                  <Th>Priority</Th>
                  <Th>Notes</Th>
                  <Th className="pr-4">Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ issue, owner }) => {
                  const isOwner = issue.ownerId === ctx.personId;
                  const readOnly =
                    ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
                  return (
                    <tr
                      key={issue.id}
                      className="border-t border-border/70 align-top"
                    >
                      <Td className="pl-4 font-medium">{issue.title}</Td>
                      <Td>
                        <OwnerChip name={owner?.name ?? null} />
                      </Td>
                      <Td>
                        <PriorityChip priority={issue.priority} />
                      </Td>
                      <Td className="min-w-[18rem]">
                        <IssueNotesEditor
                          issueId={issue.id}
                          value={issue.rootCause}
                          readOnly={readOnly}
                        />
                      </Td>
                      <Td className="pr-4 min-w-[16rem]">
                        <IssueActionButtons
                          issueId={issue.id}
                          status={issue.status as "open" | "ids_in_progress"}
                          readOnly={readOnly}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "border-b border-border/70 bg-card/40 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 text-sm", className)}>{children}</td>;
}

function Pill({
  tone,
  label,
}: {
  tone: "amber" | "muted";
  label: string;
}) {
  const dot = tone === "amber" ? "bg-amber-400" : "bg-muted-foreground/40";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function PriorityChip({
  priority,
}: {
  priority: "critical" | "high" | "medium" | "low";
}) {
  const tone =
    priority === "critical" ? "red" : priority === "high" ? "yellow" : "muted";
  return <StatusChip tone={tone}>{priority}</StatusChip>;
}
