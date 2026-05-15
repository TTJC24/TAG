// Builds the structured payload sent to Jerry on every prompt.
//
// Pulls the active org's full board state — scorecard with last-3-week
// history, rocks, open todos, open issues, readiness — plus pointers to
// the most recent transcripts. Strictly org-scoped. No cross-org reads.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  meetings,
  transcripts,
  type Transcript,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/context";
import { getNextMeeting, getRecentWeeks } from "@/lib/queries/me";
import { getOrgScorecard } from "@/lib/queries/scorecard";
import {
  getOrgIssues,
  getOrgRocks,
  getOrgTodos,
} from "@/lib/queries/org-lists";
import { getOrgTeamView } from "@/lib/queries/org-readiness";
import type {
  JerryIssueSnapshot,
  JerryMeasurableSnapshot,
  JerryReadinessSnapshot,
  JerryRequest,
  JerryRockSnapshot,
  JerryTodoSnapshot,
  JerryTranscriptRef,
} from "./types";

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function buildJerryContext(
  ctx: AuthContext,
  prompt: string,
): Promise<JerryRequest> {
  const today = new Date().toISOString().slice(0, 10);

  const weeks = await getRecentWeeks(4);
  const weekIds = weeks.map((w) => w.id);
  const currentWeek = weeks[weeks.length - 1] ?? null;

  const [
    scorecard,
    rocks,
    todos,
    issues,
    teamView,
    nextMeeting,
    txs,
  ] = await Promise.all([
    getOrgScorecard(ctx.orgId, weekIds),
    getOrgRocks(ctx.orgId),
    getOrgTodos(ctx.orgId),
    getOrgIssues(ctx.orgId),
    getOrgTeamView(ctx.orgId, currentWeek?.id ?? null, today),
    getNextMeeting(ctx.orgId),
    getRecentTranscripts(ctx.orgId, 5),
  ]);

  const measurableSnaps: JerryMeasurableSnapshot[] = scorecard.map((row) => {
    const history = weeks.slice(0, -1).map((w) => ({
      weekEndingDate: w.weekEndingDate,
      actual: num(row.entriesByWeek[w.id]?.actual),
    }));
    const currentEntry = currentWeek
      ? row.entriesByWeek[currentWeek.id]
      : undefined;
    return {
      measurableId: row.measurable.id,
      name: row.measurable.name,
      ownerName: row.owner?.name ?? null,
      goalDirection: row.measurable.goalDirection,
      goalValue: num(row.measurable.goalValue),
      formatHint: row.measurable.formatHint,
      currentActual: num(currentEntry?.actual),
      history,
    };
  });

  const rockSnaps: JerryRockSnapshot[] = rocks.map(({ rock, owner }) => ({
    rockId: rock.id,
    description: rock.description,
    ownerName: owner?.name ?? null,
    status: rock.status,
    notes: rock.notes,
    quarter: rock.quarter,
  }));

  const todoSnaps: JerryTodoSnapshot[] = todos.map(({ todo, owner }) => ({
    todoId: todo.id,
    description: todo.description,
    ownerName: owner?.name ?? null,
    dueDate: todo.dueDate,
    status: todo.status as "open" | "rolled_over",
    rolloverCount: todo.rolloverCount,
    notes: todo.notes,
  }));

  const issueSnaps: JerryIssueSnapshot[] = issues.map(({ issue, owner }) => ({
    issueId: issue.id,
    title: issue.title,
    ownerName: owner?.name ?? null,
    priority: issue.priority,
    status: issue.status as "open" | "ids_in_progress",
    rootCause: issue.rootCause,
  }));

  const readinessSnaps: JerryReadinessSnapshot[] = teamView.map((m) => ({
    personName: m.person.name,
    obligated: m.obligated,
    status: m.readiness.status,
    label: m.readiness.label,
    missingMeasurables: m.readiness.missingMeasurables,
    totalMeasurables: m.readiness.totalMeasurables,
    overdueTodos: m.readiness.overdueTodos,
  }));

  const transcriptRefs: JerryTranscriptRef[] = txs.map((t) => ({
    transcriptId: t.id,
    meetingDate: t.meetingDate,
    source: t.source as "fireflies" | "teams_native" | "transcript_manual",
    durationSec: t.durationSec,
    hasUtterances: t.hasUtterances,
  }));

  return {
    prompt,
    org: {
      orgId: ctx.orgId,
      orgName: ctx.orgName,
      orgSlug: ctx.orgSlug,
    },
    actor: {
      personId: ctx.personId,
      name: ctx.personName,
      email: "",
      role: ctx.role,
    },
    week: currentWeek
      ? {
          weekId: currentWeek.id,
          weekEndingDate: currentWeek.weekEndingDate,
          quarter: currentWeek.quarter,
        }
      : null,
    meeting: {
      nextScheduledFor: nextMeeting?.scheduledFor.toISOString() ?? null,
    },
    scorecard: measurableSnaps,
    rocks: rockSnaps,
    todos: todoSnaps,
    issues: issueSnaps,
    readiness: readinessSnaps,
    transcripts: transcriptRefs,
  };
}

interface TranscriptRefRow {
  id: string;
  meetingDate: string | null;
  source: Transcript["source"];
  durationSec: number | null;
  hasUtterances: boolean;
}

async function getRecentTranscripts(
  orgId: string,
  limit: number,
): Promise<TranscriptRefRow[]> {
  // Transcripts join meetings → meetings.org_id filter.
  const rows = await db
    .select({
      id: transcripts.id,
      meetingId: transcripts.meetingId,
      source: transcripts.source,
      durationSec: transcripts.durationSec,
      utterances: transcripts.utterances,
      meetingDate: meetings.scheduledFor,
    })
    .from(transcripts)
    .innerJoin(meetings, eq(transcripts.meetingId, meetings.id))
    .where(and(eq(meetings.orgId, orgId), inArray(meetings.status, ["scheduled", "live", "concluded"])))
    .orderBy(desc(meetings.scheduledFor))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    meetingDate: r.meetingDate ? r.meetingDate.toISOString().slice(0, 10) : null,
    source: r.source,
    durationSec: r.durationSec,
    hasUtterances: r.utterances !== null && r.utterances !== undefined,
  }));
}
