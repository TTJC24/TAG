import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgTeamView, type OrgTeamMember } from "@/lib/queries/org-readiness";
import { StatusChip } from "@/components/ui/primitives";
import { SurfaceBlock, type BlockStatus } from "@/components/ui/surface-block";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";

export const dynamic = "force-dynamic";

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

function formatMeetingDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

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
    <main className="container space-y-7 py-7">
      <SurfaceHeader
        eyebrow={`${ctx.orgName} · accountability`}
        title="Readiness"
        sub={
          currentWeek
            ? `week ending ${currentWeek.weekEndingDate} · next L10 ${nextL10} · read-only — owners edit on /me`
            : `next L10 ${nextL10} · read-only — owners edit on /me`
        }
      >
        <StatNumber value={counts.red} label="not ready" tone="red" hero />
        <StatNumber value={counts.yellow} label="almost" tone="yellow" />
        <StatNumber value={counts.green} label="ready" tone="green" />
        <StatNumber value={counts.none} label="no obligations" tone="muted" />
      </SurfaceHeader>

      {members.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No members in this org yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((m) => {
            const status: BlockStatus = m.obligated ? m.readiness.status : "muted";
            const filled =
              m.readiness.totalMeasurables - m.readiness.missingMeasurables;
            const hasMeasurables = m.obligated && m.readiness.totalMeasurables > 0;
            const missing = hasMeasurables && m.readiness.missingMeasurables > 0;
            return (
              <SurfaceBlock key={m.person.id} status={status} className="min-h-[11rem]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-medium leading-tight tracking-tight text-foreground">
                      {m.person.name}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                      {m.person.email}
                    </p>
                  </div>
                  {m.person.role === "admin" && (
                    <span className="eyebrow shrink-0">admin</span>
                  )}
                </div>

                <div className="mt-3">
                  {m.obligated ? (
                    <StatusChip tone={m.readiness.status}>
                      {m.readiness.label}
                    </StatusChip>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No obligations
                    </span>
                  )}
                </div>

                <div className="flex-1" />

                {m.obligated && (
                  <div className="mt-4 flex items-end gap-6">
                    {hasMeasurables && (
                      <StatNumber
                        value={`${filled}/${m.readiness.totalMeasurables}`}
                        label="filled"
                        tone={missing ? "red" : "green"}
                      />
                    )}
                    <StatNumber
                      value={m.readiness.overdueTodos}
                      label="overdue"
                      tone={m.readiness.overdueTodos > 0 ? "yellow" : "muted"}
                    />
                  </div>
                )}

                <div className="mt-3 border-t border-border/50 pt-3">
                  <span className="eyebrow text-muted-foreground/70">
                    owes&nbsp;&nbsp;{describeOwes(m)}
                  </span>
                </div>
              </SurfaceBlock>
            );
          })}
        </div>
      )}
    </main>
  );
}
