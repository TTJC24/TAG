"use client";

import { useMemo, useState } from "react";
import { IssueActionButtons } from "@/components/issue-action-buttons";
import { IssueRowControls } from "@/components/issue-dialogs";
import { IssueNotesEditor } from "@/components/issue-notes-editor";
import {
  DataTable,
  EmptyBlock,
  MetricStat,
  OwnerChip,
  Panel,
  PanelHeader,
  SegmentedControl,
  StatusChip,
  SummaryBar,
  Td,
  Th,
  type StatusTone,
} from "@/components/ui/primitives";
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

// Priority → status semantics for the row spine + priority chip.
//   critical / high → red (must be solved now)
//   medium          → yellow
//   low             → muted (neutral spine omitted)
const PRIORITY_TONE: Record<Priority, StatusTone> = {
  critical: "red",
  high: "yellow",
  medium: "yellow",
  low: "muted",
};

const SPINE: Record<Priority, string> = {
  critical: "spine-red",
  high: "spine-red",
  medium: "spine-yellow",
  low: "",
};

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
      <Panel>
        <EmptyBlock className="py-8 text-sm">
          No open issues for this org.
        </EmptyBlock>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {/* CommandStrip — surface summary + priority filter (presentation only). */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SummaryBar>
          <MetricStat
            label="critical"
            value={counts.critical}
            tone={counts.critical > 0 ? "red" : "muted"}
          />
          <MetricStat
            label="high"
            value={counts.high}
            tone={counts.high > 0 ? "yellow" : "muted"}
          />
          <MetricStat label="open total" value={counts.open} tone="neutral" />
        </SummaryBar>
        <SegmentedControl<Filter>
          options={filterOptions}
          value={filter}
          onChange={setFilter}
        />
      </div>

      <Panel>
        <PanelHeader
          title="Issue"
          count={visible.length}
          hint="critical first"
        />
        <div className="overflow-x-auto">
          <DataTable>
            <thead>
              <tr>
                <Th className="w-[7.5rem] pl-4">Priority</Th>
                <Th>Issue</Th>
                <Th className="w-[12rem]">Owner</Th>
                <Th className="min-w-[18rem]">Notes</Th>
                <Th className="min-w-[16rem]">Status</Th>
                <Th align="right" className="pr-4">
                  {" "}
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr className="border-t border-border/70">
                  <td colSpan={6}>
                    <EmptyBlock>No {filter} issues.</EmptyBlock>
                  </td>
                </tr>
              ) : (
                visible.map((issue) => (
                  <tr
                    key={issue.id}
                    className={cn(
                      "group h-9 border-t border-border/70 align-middle transition-colors hover:bg-surface-2/60",
                      SPINE[issue.priority],
                    )}
                  >
                    <Td className="pl-4">
                      <StatusChip tone={PRIORITY_TONE[issue.priority]}>
                        {issue.priority}
                      </StatusChip>
                    </Td>
                    <Td className="font-medium">{issue.title}</Td>
                    <Td>
                      <OwnerChip name={issue.ownerName} />
                    </Td>
                    <Td className="min-w-[18rem] py-1.5 align-top">
                      <IssueNotesEditor
                        issueId={issue.id}
                        value={issue.rootCause}
                        readOnly={issue.readOnly}
                      />
                    </Td>
                    <Td className="min-w-[16rem] py-1.5 align-top">
                      <IssueActionButtons
                        issueId={issue.id}
                        status={issue.status}
                        readOnly={issue.readOnly}
                      />
                    </Td>
                    <Td align="right" className="pr-4">
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
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Panel>
    </div>
  );
}
