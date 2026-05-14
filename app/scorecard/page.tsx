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
import { formatActual, formatGoal } from "@/lib/format";
import { EditableEntryCell } from "@/components/editable-entry-cell";
import { LiveSync } from "@/components/live-sync";
import { AddKPIButton, KPIRowControls } from "@/components/kpi-dialogs";
import {
  Eyebrow,
  MissingMarker,
  OwnerChip,
  Panel,
  PanelHeader,
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
  const priorWeeks = weeks.slice(0, -1);
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
          { actual, noteClassification: e?.noteClassification as NoteClassification | null, statusOverride: e?.statusOverride as StatusColor | null },
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

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Eyebrow>{ctx.orgName} · Scorecard</Eyebrow>
          <h1 className="text-xl font-semibold tracking-tight">
            Weekly measurables
          </h1>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <Pill tone="red" label={`${summary.red} red`} />
          <Pill tone="yellow" label={`${summary.yellow} yellow`} />
          <Pill tone="green" label={`${summary.green} green`} />
          <Pill tone="missing" label={`${summary.missing} missing`} />
          {isAdmin && <AddKPIButton members={members} />}
        </div>
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
            title="KPI"
            count={rows.length}
            hint={
              mostRecentWeek
                ? `current: week ending ${mostRecentWeek.weekEndingDate}`
                : "no week"
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <Th className="pl-4">KPI</Th>
                  <Th>Owner</Th>
                  <Th>Goal</Th>
                  <Th className="text-right">This week</Th>
                  <Th>Trend (3w)</Th>
                  {priorWeeks.map((w) => (
                    <Th key={w.id} className="text-right tabular">
                      {weekHeader(w.weekEndingDate)}
                    </Th>
                  ))}
                  <Th className="text-right">Updated</Th>
                  <Th className="pr-4 text-right"> </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ScorecardRowView
                    key={row.measurable.id}
                    row={row}
                    weeks={weeks}
                    priorWeeks={priorWeeks}
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
  priorWeeks,
  mostRecentWeekId,
  actorRole,
  actorPersonId,
  members,
}: {
  row: ScorecardRow;
  weeks: { id: string; weekEndingDate: string }[];
  priorWeeks: { id: string; weekEndingDate: string }[];
  mostRecentWeekId: string | null;
  actorRole: "admin" | "member" | "viewer";
  actorPersonId: string;
  members: { id: string; name: string }[];
}) {
  const m = shadingMeasurableFor(row);
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

  const trendPoints: TrendPoint[] = weeks.map((w) => {
    const e = row.entriesByWeek[w.id];
    const actual = parseNumeric(e?.actual);
    const r = cellResult(weeks, weeks.indexOf(w), row);
    const sign: -1 | 0 | 1 | null =
      actual === null ? null : r?.status === "red" ? -1 : r?.status === "yellow" ? 0 : 1;
    return { weekEndingDate: w.weekEndingDate, actual, toneSign: sign };
  });

  const updated = currentEntry?.enteredAt
    ? formatRelative(new Date(currentEntry.enteredAt))
    : null;

  return (
    <tr className="border-t border-border/70 align-middle">
      <Td className="pl-4 font-medium">{row.measurable.name}</Td>
      <Td>
        <OwnerChip name={row.owner?.name ?? null} />
      </Td>
      <Td className="text-muted-foreground tabular font-mono text-xs">
        {formatGoal(
          row.measurable.goalDirection,
          parseNumeric(row.measurable.goalValue),
          parseNumeric(row.measurable.goalSecondary),
          row.measurable.formatHint,
        )}
      </Td>
      <Td className="text-right">
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
      </Td>
      <Td>
        <TrendStrip points={trendPoints} />
      </Td>
      {priorWeeks.map((w, i) => {
        const e = row.entriesByWeek[w.id];
        const actual = parseNumeric(e?.actual);
        const r = cellResult(weeks, i, row);
        return (
          <Td key={w.id} className="text-right tabular">
            {actual === null ? (
              <MissingMarker label="—" className="text-muted-foreground/50" />
            ) : (
              <span
                className={cn(
                  "font-mono text-xs",
                  r?.status === "red"
                    ? "text-rose-300"
                    : r?.status === "yellow"
                      ? "text-amber-200"
                      : "text-foreground/80",
                )}
                title={e?.note ?? r?.reason}
              >
                {formatActual(actual, row.measurable.formatHint)}
              </span>
            )}
          </Td>
        );
      })}
      <Td className="text-right font-mono text-[10px] text-muted-foreground/70">
        {updated ?? <MissingMarker label="not entered" />}
      </Td>
      <Td className="pr-4 text-right">
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
      </Td>
    </tr>
  );
  void m; // shading is computed inside cellResult; m kept for parity
}

// ── Subcomponents ────────────────────────────────────────────────────────────

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
  tone: "red" | "yellow" | "green" | "missing";
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
      (row.entriesByWeek[w.id]?.noteClassification as NoteClassification | null) ?? null,
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
