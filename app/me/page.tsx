import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import {
  ensureCurrentWeek,
  getNextMeeting,
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
import { computeReadiness } from "@/lib/readiness/compute-readiness";
import { EditableEntryCell } from "@/components/editable-entry-cell";
import { ReadinessBanner } from "@/components/readiness-banner";
import { RockStatusPill } from "@/components/rock-status-pill";
import { TodoCheckbox } from "@/components/todo-checkbox";
import { LiveSync } from "@/components/live-sync";
import {
  CommandStrip,
  DataTable,
  Td,
  Th,
  EmptyBlock,
  Panel,
  PanelHeader,
  StatusDot,
  StatusChip,
  type StatusTone,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

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

  // Entity-local weeks (ADR-0013): ensure this org's current week exists, then
  // show the trailing window anchored on it. Null cadence → no week columns.
  const currentWeek = await ensureCurrentWeek(ctx.orgId, ctx.weekEndsOn);
  const recent = currentWeek ? await getRecentWeeks(ctx.orgId, 8) : [];
  const weeks = currentWeek
    ? (() => {
        const upTo = recent.filter(
          (w) => w.weekEndingDate <= currentWeek.weekEndingDate,
        );
        const all = upTo.some((w) => w.id === currentWeek.id)
          ? upTo
          : [...upTo, currentWeek];
        return all
          .slice()
          .sort((a, b) => a.weekEndingDate.localeCompare(b.weekEndingDate))
          .slice(-4);
      })()
    : [];
  const weekIds = weeks.map((w) => w.id);
  const [myMeasurables, myRocks, myTodos, myIssues, nextMeeting] =
    await Promise.all([
      getMyMeasurables(ctx.personId, ctx.orgId, weekIds),
      getMyRocks(ctx.personId, ctx.orgId),
      getMyOpenTodos(ctx.personId, ctx.orgId),
      getMyIssues(ctx.personId, ctx.orgId),
      getNextMeeting(ctx.orgId),
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

  const readiness = computeReadiness({
    measurables: measurablesWithStatus.map((row) => ({
      measurableId: row.measurable.id,
      currentActual: parseNumeric(row.currentEntry?.actual),
    })),
    openTodos: myTodos.map((t) => ({ todoId: t.id, dueDate: t.dueDate })),
    today: new Date().toISOString().slice(0, 10),
  });

  const today = new Date().toISOString().slice(0, 10);
  const readOnly = ctx.role === "viewer";

  // Derived counts for the panel headers' "needs attention" hints.
  const openMeasurables = measurablesWithStatus.length;
  const measurablesOffPlan = measurablesWithStatus.filter(
    (m) => m.result.status === "red" || m.result.status === "yellow",
  ).length;
  const rocksOffTrack = myRocks.filter((r) => r.status === "off_track").length;
  const overdueTodos = myTodos.filter(
    (t) => t.dueDate !== null && t.dueDate < today,
  ).length;

  return (
    <main className="container space-y-6 py-6">
      <LiveSync clerkOrgId={ctx.clerkOrgId} />

      {/* ─── Cockpit header ──────────────────────────────────────── */}
      <CommandStrip
        eyebrow={`${ctx.orgName} · L10 prep`}
        title={`${ctx.personName.split(" ")[0]}'s cockpit`}
        right={
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            measurables · rocks · to-dos · issues — red first
          </p>
        }
      />

      {/* ─── Readiness hero ──────────────────────────────────────── */}
      <ReadinessBanner
        result={readiness}
        nextMeetingDate={nextMeeting?.scheduledFor.toISOString() ?? null}
      />

      {/* ─── Operational grid ────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ── Measurables ──────────────────────────────────────── */}
        <Panel className="xl:col-span-2">
          <PanelHeader
            title="Measurables"
            count={openMeasurables}
            right={
              measurablesOffPlan > 0 ? (
                <span className="font-mono text-[11px] tabular text-muted-foreground">
                  {measurablesOffPlan} off plan
                </span>
              ) : undefined
            }
          />
          {measurablesWithStatus.length === 0 ? (
            <EmptyBlock>
              You don&apos;t own any Measurables in this org.
            </EmptyBlock>
          ) : (
            <div className="overflow-x-auto">
              <DataTable>
                <thead>
                  <tr>
                    <Th>KPI</Th>
                    <Th>Goal</Th>
                    {weeks.map((w, i) => (
                      <Th
                        key={w.id}
                        align="right"
                        className={
                          i === weeks.length - 1 ? "text-foreground" : undefined
                        }
                      >
                        {weekHeader(w.weekEndingDate)}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {measurablesWithStatus.map((row) => (
                    <tr
                      key={row.measurable.id}
                      tabIndex={0}
                      className={cn(
                        "data-row group h-9 border-b border-border/60 transition-colors last:border-0 hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:outline-none",
                        spineClass(row.result.status),
                      )}
                    >
                      <Td className="font-medium text-foreground">
                        <span className="inline-flex items-center gap-2">
                          <StatusDot status={row.result.status} />
                          {row.measurable.name}
                        </span>
                      </Td>
                      <Td className="font-mono text-xs text-muted-foreground">
                        {formatGoal(
                          row.measurable.goalDirection,
                          parseNumeric(row.measurable.goalValue),
                          parseNumeric(row.measurable.goalSecondary),
                          row.measurable.formatHint,
                        )}
                      </Td>
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
                          <Td key={w.id} align="right" className="py-1">
                            <div className="flex justify-end">
                              <EditableEntryCell
                                measurableId={row.measurable.id}
                                weekId={w.id}
                                currentActual={parseNumeric(e?.actual)}
                                currentNote={e?.note ?? null}
                                display={display}
                                result={cellResult}
                                readOnly={!isCurrent || readOnly}
                                rawValueForEdit={editValueFor(
                                  parseNumeric(e?.actual),
                                  row.measurable.formatHint,
                                )}
                              />
                            </div>
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </div>
          )}
        </Panel>

        {/* ── Rocks ────────────────────────────────────────────── */}
        <Panel>
          <PanelHeader
            title="Rocks"
            count={myRocks.length}
            right={
              rocksOffTrack > 0 ? (
                <span className="font-mono text-[11px] tabular text-status-red">
                  {rocksOffTrack} off track
                </span>
              ) : undefined
            }
          />
          {myRocks.length === 0 ? (
            <EmptyBlock>No active Rocks for you this quarter.</EmptyBlock>
          ) : (
            <ul>
              {myRocks.map((r) => (
                <li
                  key={r.id}
                  tabIndex={0}
                  className={cn(
                    "data-row group flex items-start gap-3 border-b border-border/60 px-4 py-2.5 transition-colors last:border-0 hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:outline-none",
                    spineClass(rockStatusTone(r.status)),
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <span className="block text-sm font-medium leading-snug text-foreground">
                      {r.description}
                    </span>
                    {r.notes && (
                      <p className="font-mono text-[11px] leading-snug text-muted-foreground">
                        {r.notes}
                      </p>
                    )}
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">
                      {r.quarter}
                      {r.dueDate ? ` · due ${r.dueDate}` : ""}
                    </p>
                  </div>
                  <RockStatusPill
                    rockId={r.id}
                    status={r.status}
                    readOnly={readOnly}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ── To-Dos ───────────────────────────────────────────── */}
        <Panel>
          <PanelHeader
            title="To-Dos"
            count={myTodos.length}
            right={
              overdueTodos > 0 ? (
                <span className="font-mono text-[11px] tabular text-status-red">
                  {overdueTodos} overdue
                </span>
              ) : undefined
            }
          />
          {myTodos.length === 0 ? (
            <EmptyBlock>No open To-Dos. You&apos;re clear.</EmptyBlock>
          ) : (
            <ul>
              {myTodos.map((t) => {
                const overdue = t.dueDate !== null && t.dueDate < today;
                return (
                  <li
                    key={t.id}
                    tabIndex={0}
                    className={cn(
                      "data-row group flex items-center gap-3 border-b border-border/60 px-4 py-2 transition-colors last:border-0 hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:outline-none",
                      overdue && "spine-red",
                    )}
                  >
                    <TodoCheckbox
                      todoId={t.id}
                      done={t.status === "done"}
                      readOnly={readOnly}
                    />
                    <span className="flex-1 text-sm leading-snug text-foreground">
                      {t.description}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11px] tabular",
                        overdue ? "text-status-red" : "text-muted-foreground",
                      )}
                    >
                      {t.dueDate ?? "—"}
                      {t.rolloverCount > 0 ? ` · ${t.rolloverCount}×` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* ── Issues ───────────────────────────────────────────── */}
        <Panel className="xl:col-span-2">
          <PanelHeader title="Issues" count={myIssues.length} hint="raised by you" />
          {myIssues.length === 0 ? (
            <EmptyBlock>No open Issues you own.</EmptyBlock>
          ) : (
            <ul className="md:grid md:grid-cols-2">
              {myIssues.map((i) => (
                <li
                  key={i.id}
                  tabIndex={0}
                  className={cn(
                    "data-row group space-y-1 border-b border-border/60 px-4 py-2.5 transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:outline-none",
                    spineClass(priorityTone(i.priority)),
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium leading-snug text-foreground">
                      {i.title}
                    </span>
                    <StatusChip
                      tone={priorityTone(i.priority)}
                      className="shrink-0"
                    >
                      {i.priority}
                    </StatusChip>
                  </div>
                  {i.rootCause && (
                    <p className="font-mono text-[11px] leading-snug text-muted-foreground">
                      {i.rootCause}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
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

/** Row status spine class for a shading status. Neutral (green) rows omit it
 *  so the spine reads as "needs attention". */
function spineClass(status: StatusTone): string | undefined {
  return status === "red"
    ? "spine-red"
    : status === "yellow"
      ? "spine-yellow"
      : undefined;
}

/** Map a rock status to a spine tone — off track is the only one that earns
 *  an attention spine. Status-color meaning is preserved (pill keeps its own
 *  color map). */
function rockStatusTone(
  status: "on_track" | "off_track" | "still_going" | "completed",
): StatusTone {
  return status === "off_track" ? "red" : "muted";
}

/** Map issue priority to a status tone for the chip + spine. Critical/high
 *  read as red, medium as yellow, low neutral. Presentation only. */
function priorityTone(
  priority: "critical" | "high" | "medium" | "low",
): StatusTone {
  return priority === "critical" || priority === "high"
    ? "red"
    : priority === "medium"
      ? "yellow"
      : "muted";
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
