import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getRecentWeeks } from "@/lib/queries/me";
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
  const rows = await getOrgScorecard(ctx.orgId, weekIds);
  const mostRecentWeekId = weeks[weeks.length - 1]?.id;

  return (
    <main className="container space-y-6 py-8">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {ctx.orgSlug.toUpperCase()} · Scorecard
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Weekly measurables
        </h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} measurables · trailing {weeks.length} weeks · most
          recent on the right
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No measurables in this org yet. Run <code>pnpm seed</code> or add via
          <code> /add-measurable</code>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-3 py-2 font-medium">KPI</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Goal</th>
                {weeks.map((w) => (
                  <th key={w.id} className="px-3 py-2 font-medium tabular">
                    {weekHeader(w.weekEndingDate)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ScorecardRowView
                  key={row.measurable.id}
                  row={row}
                  weeks={weeks}
                  mostRecentWeekId={mostRecentWeekId ?? null}
                  actorRole={ctx.role}
                  actorPersonId={ctx.personId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function ScorecardRowView({
  row,
  weeks,
  mostRecentWeekId,
  actorRole,
  actorPersonId,
}: {
  row: ScorecardRow;
  weeks: { id: string; weekEndingDate: string }[];
  mostRecentWeekId: string | null;
  actorRole: "admin" | "member" | "viewer";
  actorPersonId: string;
}) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 font-medium">{row.measurable.name}</td>
      <td className="px-3 py-2 text-muted-foreground">
        {row.owner?.name ?? "—"}
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
        const e = row.entriesByWeek[w.id];
        const display = formatActual(
          parseNumeric(e?.actual),
          row.measurable.formatHint,
        );
        const isCurrent = w.id === mostRecentWeekId;
        const result = cellResult(weeks, i, row);
        const isOwner = row.measurable.ownerId === actorPersonId;
        const readOnly =
          actorRole === "viewer" ||
          (actorRole === "member" && (!isOwner || !isCurrent));
        return (
          <td key={w.id} className="px-3 py-2">
            <EditableEntryCell
              measurableId={row.measurable.id}
              weekId={w.id}
              currentActual={parseNumeric(e?.actual)}
              currentNote={e?.note ?? null}
              display={display}
              result={result}
              readOnly={readOnly}
            />
          </td>
        );
      })}
    </tr>
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
  const m: ShadingMeasurable = {
    goalDirection: row.measurable.goalDirection as GoalDirection,
    goalValue: parseNumeric(row.measurable.goalValue),
    goalSecondary: parseNumeric(row.measurable.goalSecondary),
  };
  return computeStatus(shadingEntry, m, priors);
}
