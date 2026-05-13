import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgTeamView, type OrgTeamMember } from "@/lib/queries/org-readiness";
import { formatActual, formatGoal } from "@/lib/format";
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
    redirect("/me");
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
          {ctx.orgSlug.toUpperCase()} · Team
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">L10 team view</h1>
        <p className="text-sm text-muted-foreground">
          Every member of this org with their assigned metrics, rocks, to-dos,
          and issues. Red first.
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
        <div className="grid gap-4">
          {members.map((m) => (
            <MemberCard key={m.person.id} member={m} />
          ))}
        </div>
      )}
    </main>
  );
}

// ── Member card ──────────────────────────────────────────────────────────────

function MemberCard({ member }: { member: OrgTeamMember }) {
  const { person, obligated, readiness, measurables, rocks, todos, issues } = member;
  const filled = readiness.totalMeasurables - readiness.missingMeasurables;
  return (
    <article className="rounded border border-border bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">
              {person.name}
            </h2>
            {person.role === "admin" && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                admin
              </span>
            )}
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
            {person.email}
          </p>
        </div>
        <ReadinessTag obligated={obligated} readiness={readiness} />
      </header>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Section
          title="Metrics"
          count={measurables.length}
          subtitle={
            obligated && measurables.length > 0
              ? `${filled}/${measurables.length} filled this week`
              : undefined
          }
        >
          {measurables.length === 0 ? (
            <Empty>No metrics owned.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {measurables.map((m) => (
                <li key={m.measurable.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-sm">{m.measurable.name}</span>
                  <span className="flex items-center gap-3 font-mono text-xs">
                    <span className="text-muted-foreground">
                      {formatGoal(
                        m.measurable.goalDirection,
                        parseNumeric(m.measurable.goalValue),
                        parseNumeric(m.measurable.goalSecondary),
                        m.measurable.formatHint,
                      )}
                    </span>
                    <span
                      className={cn(
                        "tabular w-20 text-right",
                        m.currentActual === null && "text-rose-300",
                      )}
                    >
                      {m.currentActual === null
                        ? "missing"
                        : formatActual(m.currentActual, m.measurable.formatHint)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Rocks" count={rocks.length}>
          {rocks.length === 0 ? (
            <Empty>No rocks owned.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {rocks.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-sm">{r.description}</span>
                  <RockStatusChip status={r.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Open to-dos" count={todos.length}>
          {todos.length === 0 ? (
            <Empty>No open to-dos.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {todos.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-sm">{t.description}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {t.dueDate ?? ""}
                    {t.rolloverCount > 0 ? ` · rolled ${t.rolloverCount}×` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Open issues" count={issues.length}>
          {issues.length === 0 ? (
            <Empty>No open issues.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {issues.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-sm">{i.title}</span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {i.priority}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </article>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

const DOT_STYLES: Record<"green" | "yellow" | "red" | "none", string> = {
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
  red: "bg-rose-400",
  none: "bg-muted-foreground/40",
};

const TAG_STYLES: Record<"green" | "yellow" | "red" | "none", string> = {
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
  yellow: "border-amber-500/30 bg-amber-500/10 text-amber-100",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-100",
  none: "border-border bg-muted/30 text-muted-foreground",
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

function ReadinessTag({
  obligated,
  readiness,
}: {
  obligated: boolean;
  readiness: OrgTeamMember["readiness"];
}) {
  const color = obligated ? readiness.status : "none";
  const label = obligated ? readiness.label : "No obligations";
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded border px-3 py-1 text-xs font-medium",
        TAG_STYLES[color],
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[color])} aria-hidden />
      {label}
    </span>
  );
}

function Section({
  title,
  count,
  subtitle,
  children,
}: {
  title: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {title}{" "}
          <span className="font-mono text-muted-foreground/70">({count})</span>
        </h3>
        {subtitle ? (
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function RockStatusChip({
  status,
}: {
  status: "on_track" | "off_track" | "completed";
}) {
  const styles: Record<typeof status, string> = {
    on_track: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
    off_track: "border-rose-500/30 bg-rose-500/10 text-rose-100",
    completed: "border-border bg-muted/30 text-muted-foreground",
  };
  const label: Record<typeof status, string> = {
    on_track: "on track",
    off_track: "off track",
    completed: "done",
  };
  return (
    <span
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        styles[status],
      )}
    >
      {label[status]}
    </span>
  );
}

function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
