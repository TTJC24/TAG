import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getRecentWeeks } from "@/lib/queries/me";
import { getOrgMembers } from "@/lib/queries/org-members";
import { getOrgScorecard, type ScorecardRow } from "@/lib/queries/scorecard";
import { computeStatus } from "@/lib/shading/compute-status";
import type {
  GoalDirection,
  NoteClassification,
  ShadingEntry,
  ShadingMeasurable,
  ShadingResult,
  StatusColor,
} from "@/lib/shading/types";
import { formatActual } from "@/lib/format";
import { EditableEntryCell } from "@/components/editable-entry-cell";
import { EditableGoalCell } from "@/components/editable-goal-cell";
import { LiveSync } from "@/components/live-sync";
import { AddKPIButton, KPIRowControls } from "@/components/kpi-dialogs";
import {
  Eyebrow,
  MetricStat,
  MissingMarker,
  OwnerChip,
  Panel,
  PanelHeader,
  StatusDot,
  SummaryBar,
  TrendStrip,
  type TrendPoint,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ScorecardPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  const weeks = await getRecentWeeks(4);
  const weekIds = weeks.map((w) => w.id);
  const [rows, members] = await Promise.all([
    getOrgScorecard(ctx.orgId, weekIds),
    getOrgMembers(ctx.orgId),
  ]);
  const mostRecentWeek = weeks[weeks.length - 1] ?? null;
  // Most-recent-first ordering for the prior-week columns: latest read sits
  // adjacent to "This week" so the eye scans newest → oldest left to right.
  const priorWeeksDesc = weeks.slice(0, -1).slice().reverse();
  const isAdmin = ctx.role === "admin";

  // Operational summary — counts that matter at the meeting.
  const summary = rows.reduce(
    (acc, r) => {
      const e = mostRecentWeek ? r.entriesByWeek[mostRecentWeek.id] : undefined;
      const actual = parseNumeric(e?.actual);
      if (actual === null) acc.missing += 1;
      else {
        const m = shadingMeasurableFor(r);
        const result = computeStatus(
          {
            actual,
            noteClassification: e?.noteClassification as NoteClassification | null,
            statusOverride: e?.statusOverride as StatusColor | null,
          },
          m,
          [],
        );
        if (result.status === "red") acc.red += 1;
        else if (result.status === "yellow") acc.yellow += 1;
        else acc.green += 1;
      }
      return acc;
    },
    { red: 0, yellow: 0, green: 0, missing: 0 },
  );

  return (
    <main className="container space-y-5 py-6">
      <LiveSync clerkOrgId={ctx.clerkOrgId} />

      {/* Command strip: title + operational summary + admin add control. */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>{ctx.orgName} · weekly measurables</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">Scorecard</h1>
        </div>
        <SummaryBar className="items-end">
          <MetricStat label="red" value={summary.red} tone="red" />
          <MetricStat label="yellow" value={summary.yellow} tone="yellow" />
          <MetricStat label="green" value={summary.green} tone="green" />
          <MetricStat label="missing" value={summary.missing} tone="muted" />
          {isAdmin && (
            <div className="ml-1 self-center">
              <AddKPIButton members={members} />
            </div>
          )}
        </SummaryBar>
      </header>

      {rows.length === 0 ? (
        <Panel>
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No measurables in this org yet.
          </p>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader
            title="Measurables"
            count={rows.length}
            hint={
              mostRecentWeek
                ? `current · week ending ${mostRecentWeek.weekEndingDate}`
                : "no week"
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <ColHead className="pl-4">Measurable</ColHead>
                  <ColHead>Owner</ColHead>
                  <ColHead>Goal</ColHead>
                  <ColHead align="right">This week</ColHead>
                  {priorWeeksDesc.map((w) => (
                    <ColHead key={w.id} align="right">
                      {weekHeader(w.weekEndingDate)}
                    </ColHead>
                  ))}
                  <ColHead align="right">Trend</ColHead>
                  <ColHead align="right">Updated</ColHead>
                  <ColHead className="pr-4" align="right">
                    {" "}
                  </ColHead>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ScorecardRowView
                    key={row.measurable.id}
                    row={row}
                    weeks={weeks}
                    priorWeeksDesc={priorWeeksDesc}
                    mostRecentWeekId={mostRecentWeek?.id ?? null}
                    actorRole={ctx.role}
                    actorPersonId={ctx.personId}
                    members={members}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </main>
  );
}

function ScorecardRowView({
  row,
  weeks,
  priorWeeksDesc,
  mostRecentWeekId,
  actorRole,
  actorPersonId,
  members,
}: {
  row: ScorecardRow;
  weeks: { id: string; weekEndingDate: string }[];
  priorWeeksDesc: { id: string; weekEndingDate: string }[];
  mostRecentWeekId: string | null;
  actorRole: "admin" | "member" | "viewer";
  actorPersonId: string;
  members: { id: string; name: string }[];
}) {
  const currentWeek = mostRecentWeekId
    ? weeks.find((w) => w.id === mostRecentWeekId)
    : null;
  const currentEntry = currentWeek ? row.entriesByWeek[currentWeek.id] : undefined;
  const currentActual = parseNumeric(currentEntry?.actual);
  const isOwner = row.measurable.ownerId === actorPersonId;
  const readOnly =
    actorRole === "viewer" || (actorRole === "member" && !isOwner);

  const currentResult = currentWeek
    ? cellResult(weeks, weeks.length - 1, row)
    : null;

  // Row status spine + leading dot reflect the current-week shading status.
  // Missing current reads stay neutral — no false signal.
  const spine =
    currentActual === null || !currentResult ? null : currentResult.status;

  const trendPoints: TrendPoint[] = weeks.map((w) => {
    const e = row.entriesByWeek[w.id];
    const actual = parseNumeric(e?.actual);
    const r = cellResult(weeks, weeks.indexOf(w), row);
    const sign: -1 | 0 | 1 | null =
      actual === null
        ? null
        : r?.status === "red"
          ? -1
          : r?.status === "yellow"
            ? 0
            : 1;
    return { weekEndingDate: w.weekEndingDate, actual, toneSign: sign };
  });

  const updated = currentEntry?.enteredAt
    ? formatRelative(new Date(currentEntry.enteredAt))
    : null;

  return (
    <tr
      className={cn(
        "data-row group/row border-t border-border/60 align-middle transition-colors hover:bg-surface-2/60",
        spine === "red"
          ? "spine-red"
          : spine === "yellow"
            ? "spine-yellow"
            : spine === "green"
              ? "spine-green"
              : undefined,
      )}
    >
      <Cell className="py-2 pl-4">
        <div className="flex items-center gap-2">
          <StatusDot status={spine ?? "muted"} />
          <span className="font-medium tracking-tight text-foreground">
            {row.measurable.name}
          </span>
        </div>
      </Cell>
      <Cell className="py-2">
        <OwnerChip name={row.owner?.name ?? null} />
      </Cell>
      <Cell className="py-2">
        <EditableGoalCell
          measurableId={row.measurable.id}
          goalDirection={
            row.measurable.goalDirection as
              | "gte"
              | "lte"
              | "eq"
              | "between"
              | "trend_down"
              | "trend_up"
          }
          goalValue={parseNumeric(row.measurable.goalValue)}
          goalSecondary={parseNumeric(row.measurable.goalSecondary)}
          formatHint={row.measurable.formatHint}
          readOnly={readOnly}
        />
      </Cell>
      <Cell align="right" className="py-2">
        {currentWeek ? (
          <div className="flex items-center justify-end">
            <EditableEntryCell
              measurableId={row.measurable.id}
              weekId={currentWeek.id}
              currentActual={currentActual}
              currentNote={currentEntry?.note ?? null}
              display={
                currentActual === null
                  ? ""
                  : formatActual(currentActual, row.measurable.formatHint)
              }
              result={currentResult}
              readOnly={readOnly}
            />
          </div>
        ) : (
          <MissingMarker label="no week" />
        )}
      </Cell>
      {priorWeeksDesc.map((w) => {
        const e = row.entriesByWeek[w.id];
        const actual = parseNumeric(e?.actual);
        const r = cellResult(weeks, weeks.indexOf(w), row);
        return (
          <Cell key={w.id} align="right" numeric className="py-2">
            {actual === null ? (
              <MissingMarker label="—" className="text-muted-foreground/40" />
            ) : (
              <span
                className={cn(
                  "text-xs",
                  r?.status === "red"
                    ? "text-status-red"
                    : r?.status === "yellow"
                      ? "text-status-yellow"
                      : "text-foreground/70",
                )}
                title={e?.note ?? r?.reason}
              >
                {formatActual(actual, row.measurable.formatHint)}
              </span>
            )}
          </Cell>
        );
      })}
      <Cell align="right" className="py-2">
        <div className="flex justify-end">
          <TrendStrip points={trendPoints} />
        </div>
      </Cell>
      <Cell
        align="right"
        className="py-2 font-mono text-[10px] tabular text-muted-foreground/70"
      >
        {updated ?? (
          <MissingMarker label="—" className="text-muted-foreground/40" />
        )}
      </Cell>
      <Cell align="right" className="py-2 pr-4">
        <div className="flex justify-end opacity-60 transition-opacity group-hover/row:opacity-100">
          <KPIRowControls
            measurableId={row.measurable.id}
            members={members}
            current={{
              measurableId: row.measurable.id,
              name: row.measurable.name,
              ownerId: row.measurable.ownerId,
              unit: row.measurable.unit ?? "",
              formatHint: row.measurable.formatHint ?? "currency_usd",
              goalDirection: row.measurable.goalDirection,
              goalValue: row.measurable.goalValue ?? "",
              goalSecondary: row.measurable.goalSecondary ?? "",
              cadence: row.measurable.cadence,
              formula: row.measurable.formula ?? "",
            }}
            readOnly={readOnly}
            canArchive={actorRole === "admin"}
          />
        </div>
      </Cell>
    </tr>
  );
}

// ── Server-rendered table head/cell helpers ─────────────────────────────────
// Thin local wrappers mirroring the Td/Th primitive API so the matrix stays a
// fully server-rendered table (streams + preserves all shading server output).
// We do not use the client SegmentedControl density toggle here because this
// surface owns no client wrapper file; the layout is dense by default.

function ColHead({
  children,
  align = "left",
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  const alignCls =
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-[var(--topbar-h,3rem)] z-10 h-8 border-b border-border bg-surface-1 px-3 align-middle font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground",
        alignCls,
        className,
      )}
    >
      {children}
    </th>
  );
}

function Cell({
  children,
  align = "left",
  numeric,
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  numeric?: boolean;
  className?: string;
}) {
  const alignCls = numeric
    ? "text-right"
    : align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";
  return (
    <td
      className={cn(
        "px-3 align-middle text-sm",
        numeric && "font-mono tabular",
        alignCls,
        className,
      )}
    >
      {children}
    </td>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function weekHeader(d: string): string {
  const [, m, day] = d.split("-");
  return `${m}/${day}`;
}

function shadingMeasurableFor(row: ScorecardRow): ShadingMeasurable {
  return {
    goalDirection: row.measurable.goalDirection as GoalDirection,
    goalValue: parseNumeric(row.measurable.goalValue),
    goalSecondary: parseNumeric(row.measurable.goalSecondary),
  };
}

function cellResult(
  weeks: { id: string }[],
  weekIndex: number,
  row: ScorecardRow,
): ShadingResult | null {
  const currentWeek = weeks[weekIndex];
  if (!currentWeek) return null;
  const entry = row.entriesByWeek[currentWeek.id];
  const priors: ShadingEntry[] = weeks.slice(0, weekIndex).map((w) => ({
    actual: parseNumeric(row.entriesByWeek[w.id]?.actual),
    noteClassification:
      (row.entriesByWeek[w.id]?.noteClassification as NoteClassification | null) ??
      null,
    statusOverride:
      (row.entriesByWeek[w.id]?.statusOverride as StatusColor | null) ?? null,
  }));
  const shadingEntry: ShadingEntry = entry
    ? {
        actual: parseNumeric(entry.actual),
        noteClassification: entry.noteClassification as NoteClassification | null,
        statusOverride: entry.statusOverride as StatusColor | null,
      }
    : { actual: null };
  return computeStatus(shadingEntry, shadingMeasurableFor(row), priors);
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return d.toISOString().slice(0, 10);
}
