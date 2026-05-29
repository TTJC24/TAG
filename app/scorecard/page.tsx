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
import { LiveSync } from "@/components/live-sync";
import { AddKPIButton, KPIRowControls } from "@/components/kpi-dialogs";
import { MetricBlock } from "@/components/metric-block";
import { cn } from "@/lib/utils";

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

  // ~12 weeks of history so each block's wave has shape to fill (sparse data
  // simply renders a shorter wave until more weeks accrue).
  const weeks = await getRecentWeeks(12);
  const weekIds = weeks.map((w) => w.id);
  const [rows, members] = await Promise.all([
    getOrgScorecard(ctx.orgId, weekIds),
    getOrgMembers(ctx.orgId),
  ]);
  const mostRecentWeek = weeks[weeks.length - 1] ?? null;
  const lastIndex = weeks.length - 1;
  const isAdmin = ctx.role === "admin";

  const blocks = rows.map((row) => {
    const series = weeks.map((w) => parseNumeric(row.entriesByWeek[w.id]?.actual));
    const currentEntry = mostRecentWeek
      ? row.entriesByWeek[mostRecentWeek.id]
      : undefined;
    const currentActual = parseNumeric(currentEntry?.actual);
    const result = mostRecentWeek ? cellResult(weeks, lastIndex, row) : null;
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
    <main className="container space-y-7 py-7">
      <LiveSync clerkOrgId={ctx.clerkOrgId} />

      <header className="space-y-3">
        <p className="eyebrow">{ctx.orgName} · weekly scorecard</p>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <h1 className="font-display text-[clamp(2.25rem,5.5vw,3.75rem)] uppercase leading-[0.9] tracking-[0.01em] text-foreground">
            {ctx.orgName}
          </h1>
          <div className="flex items-end gap-6">
            <Headline value={`${summary.green}/${total}`} label="on track" />
            <Count n={summary.red} label="critical" tone="red" />
            <Count n={summary.yellow} label="watch" tone="yellow" />
            <Count n={summary.missing} label="missing" tone="muted" />
            {isAdmin && (
              <div className="self-center pl-1">
                <AddKPIButton members={members} />
              </div>
            )}
          </div>
        </div>
        {mostRecentWeek && (
          <p className="eyebrow text-muted-foreground/70">
            current · week ending {mostRecentWeek.weekEndingDate}
          </p>
        )}
      </header>

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
                weekId={mostRecentWeek?.id ?? null}
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

// ── Header stat helpers ─────────────────────────────────────────────────────

function Headline({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className="font-mono tabular text-[clamp(1.75rem,4vw,2.5rem)] font-semibold leading-none text-foreground">
        {value}
      </span>
      <span className="eyebrow mt-1.5">{label}</span>
    </div>
  );
}

function Count({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: "red" | "yellow" | "muted";
}) {
  return (
    <div className="flex flex-col items-start">
      <span
        className={cn(
          "font-mono tabular text-[clamp(1.25rem,3vw,1.75rem)] font-semibold leading-none",
          tone === "red"
            ? "text-status-red"
            : tone === "yellow"
              ? "text-status-yellow"
              : "text-muted-foreground",
        )}
      >
        {n}
      </span>
      <span className="eyebrow mt-1.5 text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Helpers (carried over from the previous table implementation) ───────────

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
