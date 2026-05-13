import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgReadiness } from "@/lib/queries/org-readiness";
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

  // Admin-only. Members and viewers get bounced to their own /me view rather
  // than a 403 — they have nothing to do here.
  if (ctx.role !== "admin") {
    redirect("/me");
  }

  const weeks = await getRecentWeeks(1);
  const currentWeek = weeks[0] ?? null;
  const today = new Date().toISOString().slice(0, 10);

  const [rows, nextMeeting] = await Promise.all([
    getOrgReadiness(ctx.orgId, currentWeek?.id ?? null, today),
    getNextMeeting(ctx.orgId),
  ]);

  const counts = rows.reduce(
    (acc, r) => {
      acc[r.readiness.status] += 1;
      return acc;
    },
    { green: 0, yellow: 0, red: 0 } as Record<"green" | "yellow" | "red", number>,
  );

  return (
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgSlug.toUpperCase()} · Admin
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">L10 readiness</h1>
        <p className="text-sm text-muted-foreground">
          Who&apos;s ready for the next meeting. Red first.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-4 rounded border border-border bg-card px-4 py-3 text-sm">
        <Pill color="red" label={`${counts.red} not ready`} />
        <Pill color="yellow" label={`${counts.yellow} almost`} />
        <Pill color="green" label={`${counts.green} ready`} />
        <span className="ml-auto font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Next L10:{" "}
          {nextMeeting
            ? formatMeetingDate(nextMeeting.scheduledFor.toISOString())
            : "not scheduled"}
          {currentWeek ? ` · week ending ${currentWeek.weekEndingDate}` : ""}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          No measurable owners in this org yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium tabular">Measurables</th>
                <th className="px-3 py-2 font-medium tabular">Overdue to-dos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ person, readiness }) => {
                const filled =
                  readiness.totalMeasurables - readiness.missingMeasurables;
                return (
                  <tr key={person.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{person.name}</span>
                        {person.role === "admin" && (
                          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            admin
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {person.email}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2.5 w-2.5 rounded-full",
                            DOT_STYLES[readiness.status],
                          )}
                          aria-hidden
                        />
                        <span>{readiness.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono tabular">
                      {filled}/{readiness.totalMeasurables}
                    </td>
                    <td className="px-3 py-2 font-mono tabular">
                      {readiness.overdueTodos}
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

const DOT_STYLES: Record<"green" | "yellow" | "red", string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
};

function Pill({
  color,
  label,
}: {
  color: "green" | "yellow" | "red";
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
