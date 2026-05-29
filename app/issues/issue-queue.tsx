"use client";

import { useMemo, useState } from "react";
import { IssueActionButtons } from "@/components/issue-action-buttons";
import { IssueRowControls } from "@/components/issue-dialogs";
import { IssueNotesEditor } from "@/components/issue-notes-editor";
import {
  OwnerChip,
  SegmentedControl,
  StatusChip,
  type StatusTone,
} from "@/components/ui/primitives";
import { SurfaceBlock, type BlockStatus } from "@/components/ui/surface-block";
import type { OrgMemberOption } from "@/lib/queries/org-members";
import { cn } from "@/lib/utils";

type Priority = "critical" | "high" | "medium" | "low";

interface IssueItem {
  id: string;
  title: string;
  status: "open" | "ids_in_progress";
  priority: Priority;
  rootCause: string | null;
  ownerId: string;
  ownerName: string | null;
  ageDays: number;
  readOnly: boolean;
}

interface Counts {
  open: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

type Filter = "all" | Priority;

// Signal Red is reserved for critical. Other priorities step down the triad.
const PRIORITY_TONE: Record<Priority, StatusTone> = {
  critical: "red",
  high: "yellow",
  medium: "yellow",
  low: "muted",
};

const PRIORITY_BLOCK: Record<Priority, BlockStatus> = {
  critical: "red",
  high: "yellow",
  medium: "neutral",
  low: "muted",
};

function ageTone(days: number): string {
  if (days > 30) return "text-status-red";
  if (days > 14) return "text-status-yellow";
  return "text-foreground";
}

export function IssueQueue({
  items,
  members,
  counts,
  canDelete,
}: {
  items: IssueItem[];
  members: OrgMemberOption[];
  counts: Counts;
  canDelete: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  // Client-side filter ONLY — never re-sorts the server's critical-first order.
  const visible = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.priority === filter)),
    [items, filter],
  );

  const filterOptions: { value: Filter; label: string; count?: number }[] = [
    { value: "all", label: "all", count: counts.open },
    { value: "critical", label: "critical", count: counts.critical },
    { value: "high", label: "high", count: counts.high },
    { value: "medium", label: "medium", count: counts.medium },
    { value: "low", label: "low", count: counts.low },
  ];

  if (items.length === 0) {
    return (
      <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        No open issues for this org.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <SegmentedControl<Filter>
          options={filterOptions}
          value={filter}
          onChange={setFilter}
        />
      </div>

      {visible.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No {filter} issues.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((issue) => (
            <SurfaceBlock
              key={issue.id}
              status={PRIORITY_BLOCK[issue.priority]}
              className="min-h-[12rem]"
            >
              <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-1.5">
                <OwnerChip name={issue.ownerName} compact />
                {!issue.readOnly && (
                  <div className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <IssueRowControls
                      issueId={issue.id}
                      members={members}
                      current={{
                        title: issue.title,
                        ownerId: issue.ownerId,
                        priority: issue.priority,
                        rootCause: issue.rootCause ?? "",
                      }}
                      readOnly={issue.readOnly}
                      canDelete={canDelete}
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pr-12">
                <StatusChip tone={PRIORITY_TONE[issue.priority]}>
                  {issue.priority}
                </StatusChip>
                {issue.status === "ids_in_progress" && (
                  <span className="eyebrow text-status-yellow">in IDS</span>
                )}
              </div>

              <p className="mt-3 text-lg font-medium leading-snug tracking-tight text-foreground">
                {issue.title}
              </p>

              <div className="mt-2 flex items-baseline gap-1.5">
                <span
                  className={cn(
                    "font-mono tabular text-base font-semibold leading-none",
                    ageTone(issue.ageDays),
                  )}
                >
                  {issue.ageDays}d
                </span>
                <span className="eyebrow">open</span>
              </div>

              <div className="flex-1" />

              <div className="mt-3">
                <IssueActionButtons
                  issueId={issue.id}
                  status={issue.status}
                  readOnly={issue.readOnly}
                />
              </div>

              <div className="mt-3 border-t border-border/50 pt-3">
                <IssueNotesEditor
                  issueId={issue.id}
                  value={issue.rootCause}
                  readOnly={issue.readOnly}
                />
              </div>
            </SurfaceBlock>
          ))}
        </div>
      )}
    </div>
  );
}
