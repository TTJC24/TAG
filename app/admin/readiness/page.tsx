import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgTeamView, type OrgTeamMember } from "@/lib/queries/org-readiness";
import {
  CommandStrip,
  DataTable,
  Eyebrow,
  EmptyBlock,
  MetricStat,
  OwnerChip,
  Panel,
  PanelHeader,
  StatusChip,
  StatusDot,
  SummaryBar,
  Td,
  Th,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AdminReadinessPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  if (ctx.role !== "admin") {
    redirect("/scorecard");
  }

  const weeks = await getRecentWeeks(1);
  const currentWeek = weeks[0] ?? null;
  const today = new Date().toISOString().slice(0, 10);

  const [members, nextMeeting] = await Promise.all([
    getOrgTeamView(ctx.orgId, currentWeek?.id ?? null, today),
    getNextMeeting(ctx.orgId),
  ]);

  const counts = members.reduce(
    (acc, m) => {
      if (!m.obligated) acc.none += 1;
      else acc[m.readiness.status] += 1;
      return acc;
    },
    { red: 0, yellow: 0, green: 0, none: 0 } as Record<
      "red" | "yellow" | "green" | "none",
      number
    >,
  );

  const nextL10 = nextMeeting
    ? formatMeetingDate(nextMeeting.scheduledFor.toISOString())
    : "not scheduled";

  return (
    <main className="container space-y-5 py-6">
      <CommandStrip
        eyebrow={`${ctx.orgName} · Accountability`}
        title="Readiness"
        right={
          <SummaryBar className="items-end">
            <MetricStat
              label="Not ready"
              value={counts.red}
              tone={counts.red > 0 ? "red" : "muted"}
            />
            <MetricStat
              label="Almost"
              value={counts.yellow}
              tone={counts.yellow > 0 ? "yellow" : "muted"}
            />
            <MetricStat
              label="Ready"
              value={counts.green}
              tone={counts.green > 0 ? "green" : "muted"}
            />
            <MetricStat label="No obligations" value={counts.none} tone="muted" />
            <div className="ml-2 flex flex-col gap-1 self-end pb-0.5">
              <Eyebrow>Next L10</Eyebrow>
              <span className="font-mono text-sm tabular text-foreground/90">
                {nextL10}
              </span>
            </div>
          </SummaryBar>
        }
      />

      {members.length === 0 ? (
        <Panel>
          <EmptyBlock className="py-8 text-sm">
            No members in this org yet.
          </EmptyBlock>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader
            title="Team"
            count={members.length}
            hint={
              currentWeek
                ? `current: week ending ${currentWeek.weekEndingDate}`
                : "no week"
            }
            right={
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                read-only · edit on /me
              </span>
            }
          />
          <div className="overflow-x-auto">
            <DataTable>
              <thead>
                <tr>
                  <Th className="pl-4">Person</Th>
                  <Th>Status</Th>
                  <Th align="right">Filled this week</Th>
                  <Th align="right">Overdue to-dos</Th>
                  <Th className="pr-4">Owes</Th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const filled =
                    m.readiness.totalMeasurables - m.readiness.missingMeasurables;
                  const dot: "green" | "yellow" | "red" | "muted" = m.obligated
                    ? m.readiness.status
                    : "muted";
                  const label = m.obligated ? m.readiness.label : "No obligations";
                  const hasMeasurables =
                    m.obligated && m.readiness.totalMeasurables > 0;
                  const missing = hasMeasurables && m.readiness.missingMeasurables > 0;
                  return (
                    <tr
                      key={m.person.id}
                      className={cn(
                        "h-9 border-t border-border/70 align-middle transition-colors hover:bg-surface-1/60",
                        m.obligated && SPINE[m.readiness.status],
                      )}
                    >
                      <Td className="pl-4">
                        <div className="flex items-center gap-2">
                          <OwnerChip name={m.person.name} />
                          {m.person.role === "admin" && (
                            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                              admin
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                          {m.person.email}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <StatusDot
                            status={dot}
                            pulse={m.obligated && m.readiness.status === "red"}
                          />
                          {m.obligated ? (
                            <StatusChip tone={m.readiness.status}>
                              {label}
                            </StatusChip>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {label}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td numeric>
                        {hasMeasurables ? (
                          <span
                            className={cn(missing && "text-status-red")}
                            title={`${m.readiness.missingMeasurables} missing`}
                          >
                            {filled}
                            <span className="text-muted-foreground/60">
                              /{m.readiness.totalMeasurables}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </Td>
                      <Td numeric>
                        {m.obligated ? (
                          <span
                            className={cn(
                              m.readiness.overdueTodos > 0 && "text-status-yellow",
                            )}
                          >
                            {m.readiness.overdueTodos}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </Td>
                      <Td className="pr-4 text-xs text-muted-foreground">
                        {describeOwes(m)}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </div>
        </Panel>
      )}
    </main>
  );
}

function describeOwes(m: OrgTeamMember): string {
  if (!m.obligated) return "—";
  const parts: string[] = [];
  if (m.readiness.missingMeasurables > 0)
    parts.push(
      `${m.readiness.missingMeasurables} KPI${m.readiness.missingMeasurables === 1 ? "" : "s"}`,
    );
  if (m.readiness.overdueTodos > 0)
    parts.push(
      `${m.readiness.overdueTodos} overdue todo${m.readiness.overdueTodos === 1 ? "" : "s"}`,
    );
  if (parts.length === 0) return "ready";
  return parts.join(" · ");
}

const SPINE: Record<"green" | "yellow" | "red", string> = {
  green: "spine-green",
  yellow: "spine-yellow",
  red: "spine-red",
};

function formatMeetingDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
