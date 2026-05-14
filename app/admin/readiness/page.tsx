import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgTeamView } from "@/lib/queries/org-readiness";
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
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgSlug.toUpperCase()} · Readiness
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">L10 readiness</h1>
        <p className="text-sm text-muted-foreground">
          Whether each person filled out what they own for the current week.
          Red first.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-card px-4 py-3 text-sm">
        <Pill color="red" label={`${counts.red} not ready`} />
        <Pill color="yellow" label={`${counts.yellow} almost`} />
        <Pill color="green" label={`${counts.green} ready`} />
        <Pill color="none" label={`${counts.none} no obligations`} />
        <span className="ml-auto font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Next L10:{" "}
          {nextMeeting
            ? formatMeetingDate(nextMeeting.scheduledFor.toISOString())
            : "not scheduled"}
          {currentWeek ? ` · week ending ${currentWeek.weekEndingDate}` : ""}
        </span>
      </div>

      {members.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No members in this org yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium tabular">
                  Filled this week
                </th>
                <th className="px-3 py-2 font-medium tabular">Overdue to-dos</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const filled =
                  m.readiness.totalMeasurables - m.readiness.missingMeasurables;
                const color = m.obligated ? m.readiness.status : "none";
                const label = m.obligated ? m.readiness.label : "No obligations";
                return (
                  <tr key={m.person.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.person.name}</span>
                        {m.person.role === "admin" && (
                          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            admin
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {m.person.email}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn("h-2.5 w-2.5 rounded-full", DOT_STYLES[color])}
                          aria-hidden
                        />
                        <span>{label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono tabular">
                      {m.obligated && m.readiness.totalMeasurables > 0
                        ? `${filled}/${m.readiness.totalMeasurables}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono tabular">
                      {m.obligated ? m.readiness.overdueTodos : "—"}
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

const DOT_STYLES: Record<"green" | "yellow" | "red" | "none", string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
  none: "bg-muted-foreground/40",
};

function Pill({
  color,
  label,
}: {
  color: "green" | "yellow" | "red" | "none";
  label: string;
}) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
      <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])} aria-hidden />
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
