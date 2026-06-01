import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { ensureCurrentWeek, getRecentWeeks } from "@/lib/queries/me";
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
import { LiveSync } from "@/components/live-sync";
import { AddKPIButton, KPIRowControls } from "@/components/kpi-dialogs";
import { MetricBlock } from "@/components/metric-block";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";

export const dynamic = "force-dynamic";

// Problems-first ordering — fires surface to the top of the grid.
const STATUS_ORDER: Record<StatusColor | "missing", number> = {
  red: 0,
  yellow: 1,
  green: 2,
  missing: 3,
};

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

  // Lazy generation: loading the scorecard guarantees the current week exists
  // for entities with a weekly cadence. A null weekEndsOn (e.g. CULTIVUS+)
  // returns no week — the surface renders as a manual log. See ADR-0013.
  const currentWeek = await ensureCurrentWeek(ctx.orgId, ctx.weekEndsOn);

  // History window = the weeks up to and including the current week. Anchoring
  // on the current week (not merely the latest row) keeps the editable hero on
  // "this week" even if future-dated weeks exist in the data.
  const recent = currentWeek ? await getRecentWeeks(ctx.orgId, 16) : [];
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
          .slice(-12);
      })()
    : [];
  const lastIndex = weeks.length - 1; // currentWeek sits last (when present)
  const weekId = currentWeek?.id ?? null;

  const [rows, members] = await Promise.all([
    getOrgScorecard(
      ctx.orgId,
      weeks.map((w) => w.id),
    ),
    getOrgMembers(ctx.orgId),
  ]);
  const isAdmin = ctx.role === "admin";

  const blocks = rows.map((row) => {
    const series = weeks.map((w) => parseNumeric(row.entriesByWeek[w.id]?.actual));
    const currentEntry = currentWeek
      ? row.entriesByWeek[currentWeek.id]
      : undefined;
    const currentActual = parseNumeric(currentEntry?.actual);
    const result = currentWeek ? cellResult(weeks, lastIndex, row) : null;
    const status: StatusColor | null =
      currentActual === null ? null : (result?.status ?? null);
    return { row, series, currentEntry, currentActual, result, status };
  });

  const summary = blocks.reduce(
    (acc, b) => {
      if (b.status === null) acc.missing += 1;
      else acc[b.status] += 1;
      return acc;
    },
    { red: 0, yellow: 0, green: 0, missing: 0 },
  );
  const total = blocks.length;

  const sorted = blocks
    .slice()
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status ?? "missing"] - STATUS_ORDER[b.status ?? "missing"],
    );

  return (
    <main className="container space-y-6 py-7">
      <LiveSync clerkOrgId={ctx.clerkOrgId} />

      <SurfaceHeader
        eyebrow={`${ctx.orgName} · weekly scorecard`}
        title={ctx.orgName}
      >
        <StatNumber value={`${summary.green}/${total}`} label="on track" tone="green" hero />
        <StatNumber value={summary.red} label="critical" tone="red" />
        <StatNumber value={summary.yellow} label="watch" tone="yellow" />
        <StatNumber value={summary.missing} label="missing" tone="muted" />
        {isAdmin && (
          <div className="self-center pl-1">
            <AddKPIButton members={members} />
          </div>
        )}
      </SurfaceHeader>

      {/* Unmistakable: which week these numbers go into, and that the rest is locked. */}
      <div className="flex flex-wrap items-center gap-2 rounded-[2px] border border-border bg-surface-1 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-foreground/60" />
        {currentWeek ? (
          <>
            Entering for week ending
            <span className="text-foreground">{currentWeek.weekEndingDate}</span>
            <span aria-hidden className="text-border">·</span>
            prior weeks are locked
          </>
        ) : (
          <>No weekly cadence — numbers are a manual log</>
        )}
      </div>

      {total === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No measurables in this org yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map(({ row, series, currentEntry, currentActual, result, status }) => {
            const isOwner = row.measurable.ownerId === ctx.personId;
            const readOnly =
              ctx.role === "viewer" || (ctx.role === "member" && !isOwner);
            return (
              <MetricBlock
                key={row.measurable.id}
                measurableId={row.measurable.id}
                weekId={weekId}
                name={row.measurable.name}
                ownerName={row.owner?.name ?? null}
                currentActual={currentActual}
                currentNote={currentEntry?.note ?? null}
                display={
                  currentActual === null
                    ? ""
                    : formatActual(currentActual, row.measurable.formatHint)
                }
                status={status}
                result={result}
                series={series}
                goalDirection={row.measurable.goalDirection as GoalDirection}
                goalValue={parseNumeric(row.measurable.goalValue)}
                goalSecondary={parseNumeric(row.measurable.goalSecondary)}
                formatHint={row.measurable.formatHint}
                readOnly={readOnly}
              >
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
                  canArchive={ctx.role === "admin"}
                />
              </MetricBlock>
            );
          })}
        </div>
      )}
    </main>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseNumeric(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
