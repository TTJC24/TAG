import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import {
  getRecentWeeks,
  getMyIssues,
  getMyMeasurables,
  getMyOpenTodos,
  getMyRocks,
} from "@/lib/queries/me";
import { computeStatus } from "@/lib/shading/compute-status";
import type {
  ShadingEntry,
  ShadingMeasurable,
  ShadingResult,
} from "@/lib/shading/types";
import { formatActual, formatGoal } from "@/lib/format";
import { EditableEntryCell } from "@/components/editable-entry-cell";

export const dynamic = "force-dynamic";

export default async function MePage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      // Bounce the user to home — that page surfaces the org switcher.
      redirect("/");
    }
    throw err;
  }

  const weeks = await getRecentWeeks(4);
  const weekIds = weeks.map((w) => w.id);
  const [myMeasurables, myRocks, myTodos, myIssues] = await Promise.all([
    getMyMeasurables(ctx.personId, ctx.orgId, weekIds),
    getMyRocks(ctx.personId, ctx.orgId),
    getMyOpenTodos(ctx.personId, ctx.orgId),
    getMyIssues(ctx.personId, ctx.orgId),
  ]);

  // Pre-compute shading for the most recent week's cell so the "red first"
  // sort + the cell color stay in sync.
  const mostRecentWeek = weeks[weeks.length - 1];
  const measurablesWithStatus = myMeasurables.map((row) => {
    const currentEntry = mostRecentWeek
      ? row.entriesByWeek[mostRecentWeek.id]
      : undefined;
    const priorEntries: ShadingEntry[] = weeks.slice(0, -1).map((w) => ({
      actual: parseNumeric(row.entriesByWeek[w.id]?.actual),
      noteClassification: row.entriesByWeek[w.id]?.noteClassification ?? null,
      statusOverride: row.entriesByWeek[w.id]?.statusOverride ?? null,
    }));
    const shadingMeasurable: ShadingMeasurable = {
      goalDirection: row.measurable.goalDirection,
      goalValue: parseNumeric(row.measurable.goalValue),
      goalSecondary: parseNumeric(row.measurable.goalSecondary),
    };
    const shadingEntry: ShadingEntry = currentEntry
      ? {
          actual: parseNumeric(currentEntry.actual),
          noteClassification: currentEntry.noteClassification,
          statusOverride: currentEntry.statusOverride,
        }
      : { actual: null };
    const result = computeStatus(shadingEntry, shadingMeasurable, priorEntries);
    return { ...row, currentEntry, result };
  });

  // Sort: red first, then yellow, then green. Within color, higher intensity first.
  const STATUS_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2 };
  measurablesWithStatus.sort((a, b) => {
    const oa = STATUS_ORDER[a.result.status] ?? 99;
    const ob = STATUS_ORDER[b.result.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return b.result.intensity - a.result.intensity;
  });

  return (
    <main className="container space-y-10 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgSlug.toUpperCase()} · L10 prep
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {ctx.personName.split(" ")[0]}&apos;s view
        </h1>
        <p className="text-sm text-muted-foreground">
          Your measurables, rocks, to-dos, and issues for this week. Red first.
        </p>
      </header>

      {/* ─── Measurables ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader title="Measurables" count={measurablesWithStatus.length} />
        {measurablesWithStatus.length === 0 ? (
          <Empty>You don&apos;t own any measurables in this org.</Empty>
        ) : (
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                  <th className="px-3 py-2 font-medium">KPI</th>
                  <th className="px-3 py-2 font-medium">Goal</th>
                  {weeks.map((w) => (
                    <th key={w.id} className="px-3 py-2 font-medium tabular">
                      {weekHeader(w.weekEndingDate)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {measurablesWithStatus.map((row) => (
                  <tr key={row.measurable.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">
                      {row.measurable.name}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatGoal(
                        row.measurable.goalDirection,
                        parseNumeric(row.measurable.goalValue),
                        parseNumeric(row.measurable.goalSecondary),
                        row.measurable.formatHint,
                      )}
                    </td>
                    {weeks.map((w, i) => {
                      const isCurrent = i === weeks.length - 1;
                      const e = row.entriesByWeek[w.id];
                      const display = formatActual(
                        parseNumeric(e?.actual),
                        row.measurable.formatHint,
                      );
                      const cellResult = isCurrent
                        ? row.result
                        : weekResult(weeks, i, row);
                      return (
                        <td key={w.id} className="px-3 py-2">
                          <EditableEntryCell
                            measurableId={row.measurable.id}
                            weekId={w.id}
                            currentActual={parseNumeric(e?.actual)}
                            currentNote={e?.note ?? null}
                            display={display}
                            result={cellResult}
                            readOnly={!isCurrent || ctx.role === "viewer"}
                            rawValueForEdit={editValueFor(
                              parseNumeric(e?.actual),
                              row.measurable.formatHint,
                            )}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Rocks ───────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader title="Rocks" count={myRocks.length} />
        {myRocks.length === 0 ? (
          <Empty>No active rocks for you this quarter.</Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {myRocks.map((r) => (
              <li
                key={r.id}
                className="rounded border border-border bg-card p-4"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium leading-tight">
                    {r.description}
                  </span>
                  <RockStatusPill status={r.status} />
                </div>
                {r.notes && (
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.notes}
                  </p>
                )}
                <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {r.quarter}
                  {r.dueDate ? ` · due ${r.dueDate}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── To-Dos ──────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader title="Open to-dos" count={myTodos.length} />
        {myTodos.length === 0 ? (
          <Empty>No open to-dos. You&apos;re clear.</Empty>
        ) : (
          <ul className="space-y-2">
            {myTodos.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between rounded border border-border bg-card px-3 py-2"
              >
                <span className="text-sm">{t.description}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {t.dueDate ?? ""}
                  {t.rolloverCount > 0 ? ` · rolled ${t.rolloverCount}×` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── Issues ──────────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader title="Issues you raised" count={myIssues.length} />
        {myIssues.length === 0 ? (
          <Empty>No open issues you own.</Empty>
        ) : (
          <ul className="space-y-2">
            {myIssues.map((i) => (
              <li
                key={i.id}
                className="rounded border border-border bg-card px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{i.title}</span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {i.priority}
                  </span>
                </div>
                {i.rootCause && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {i.rootCause}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** What we pre-fill in the edit input. For percent goals we surface the
 *  number as a percent (50 instead of 0.5) so the operator types what they
 *  see; the action divides by 100 before storage… actually no — we store
 *  the raw numeric. Surface the raw value, but instruct via placeholder. */
function editValueFor(actual: number | null, _hint: string | null): string {
  return actual === null ? "" : String(actual);
}

function weekHeader(d: string): string {
  // Already YYYY-MM-DD from the DB.
  const [, m, day] = d.split("-");
  return `${m}/${day}`;
}

function weekResult(
  weeks: { id: string }[],
  weekIndex: number,
  row: {
    measurable: { goalDirection: string; goalValue: string | null; goalSecondary: string | null };
    entriesByWeek: Record<string, { actual: string | null; noteClassification: string | null; statusOverride: string | null } | undefined>;
  },
): ShadingResult | null {
  // For prior weeks we run the same shading function with that week as the
  // "current" entry and the strictly-earlier weeks as history. This keeps
  // every cell self-consistent with the engine that drives the most recent
  // column.
  const currentWeek = weeks[weekIndex];
  if (!currentWeek) return null;
  const entry = row.entriesByWeek[currentWeek.id];
  const priors: ShadingEntry[] = weeks.slice(0, weekIndex).map((w) => ({
    actual: parseNumeric(row.entriesByWeek[w.id]?.actual),
    noteClassification:
      (row.entriesByWeek[w.id]?.noteClassification as
        | "explained_one_off"
        | "structural_issue"
        | "on_plan_to_recover"
        | "no_context"
        | null) ?? null,
    statusOverride:
      (row.entriesByWeek[w.id]?.statusOverride as
        | "green"
        | "yellow"
        | "red"
        | null) ?? null,
  }));
  const shadingEntry: ShadingEntry = entry
    ? {
        actual: parseNumeric(entry.actual),
        noteClassification: entry.noteClassification as
          | "explained_one_off"
          | "structural_issue"
          | "on_plan_to_recover"
          | "no_context"
          | null,
        statusOverride: entry.statusOverride as "green" | "yellow" | "red" | null,
      }
    : { actual: null };
  return computeStatus(shadingEntry, {
    goalDirection: row.measurable.goalDirection as ShadingMeasurable["goalDirection"],
    goalValue: parseNumeric(row.measurable.goalValue),
    goalSecondary: parseNumeric(row.measurable.goalSecondary),
  }, priors);
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <span className="font-mono text-xs text-muted-foreground tabular">
        {count}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function RockStatusPill({ status }: { status: string }) {
  const label = status.replace("_", " ");
  const color =
    status === "on_track"
      ? "bg-status-green/15 text-status-green"
      : status === "off_track"
        ? "bg-status-red/15 text-status-red"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${color}`}
    >
      {label}
    </span>
  );
}
