import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgTeamView } from "@/lib/queries/org-readiness";
import {
  Eyebrow,
  OwnerChip,
  Panel,
  PanelHeader,
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

  return (
    <main className="container space-y-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · Readiness</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">
            Pre-meeting accountability
          </h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <Pill tone="red" label={`${counts.red} not ready`} />
          <Pill tone="yellow" label={`${counts.yellow} almost`} />
          <Pill tone="green" label={`${counts.green} ready`} />
          <Pill tone="muted" label={`${counts.none} no obligations`} />
        </div>
      </header>

      {members.length === 0 ? (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No members in this org yet.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader
            title="Person"
            count={members.length}
            hint={
              currentWeek
                ? `current: week ending ${currentWeek.weekEndingDate}`
                : "no week"
            }
            right={
              nextMeeting ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  next L10:{" "}
                  <span className="text-foreground/90">
                    {formatMeetingDate(nextMeeting.scheduledFor.toISOString())}
                  </span>
                </span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  next L10: not scheduled
                </span>
              )
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <Th className="pl-4">Person</Th>
                  <Th>Status</Th>
                  <Th className="tabular">Filled this week</Th>
                  <Th className="tabular">Overdue to-dos</Th>
                  <Th className="pr-4">Owes</Th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const filled =
                    m.readiness.totalMeasurables - m.readiness.missingMeasurables;
                  const color = m.obligated ? m.readiness.status : "none";
                  const label = m.obligated ? m.readiness.label : "No obligations";
                  const owes = describeOwes(m);
                  return (
                    <tr
                      key={m.person.id}
                      className="border-t border-border/70 align-middle"
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
                          <span
                            aria-hidden
                            className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])}
                          />
                          <span className="text-sm">{label}</span>
                        </div>
                      </Td>
                      <Td className="font-mono text-xs tabular">
                        {m.obligated && m.readiness.totalMeasurables > 0
                          ? `${filled}/${m.readiness.totalMeasurables}`
                          : "—"}
                      </Td>
                      <Td className="font-mono text-xs tabular">
                        {m.obligated ? m.readiness.overdueTodos : "—"}
                      </Td>
                      <Td className="pr-4 text-xs text-muted-foreground">
                        {owes}
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

function describeOwes(m: {
  obligated: boolean;
  readiness: { missingMeasurables: number; overdueTodos: number };
  measurables: unknown[];
  rocks: unknown[];
  todos: unknown[];
  issues: unknown[];
}): string {
  if (!m.obligated) return "—";
  const parts: string[] = [];
  if (m.readiness.missingMeasurables > 0)
    parts.push(`${m.readiness.missingMeasurables} KPI${m.readiness.missingMeasurables === 1 ? "" : "s"}`);
  if (m.readiness.overdueTodos > 0)
    parts.push(`${m.readiness.overdueTodos} overdue todo${m.readiness.overdueTodos === 1 ? "" : "s"}`);
  if (parts.length === 0) return "ready";
  return parts.join(" · ");
}

const DOT_STYLES: Record<"green" | "yellow" | "red" | "none", string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
  none: "bg-muted-foreground/40",
};

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
  tone: "red" | "yellow" | "green" | "muted";
  label: string;
}) {
  const dot =
    tone === "red"
      ? "bg-rose-400"
      : tone === "yellow"
        ? "bg-amber-400"
        : tone === "green"
          ? "bg-emerald-400"
          : "bg-muted-foreground/40";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
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
