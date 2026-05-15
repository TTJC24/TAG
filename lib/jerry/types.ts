// Wire types for the in-app Jerry integration. Jerry itself runs
// outside the app (existing service on the shared droplet); this app
// is a client. Treat Jerry as opaque — these types describe the wire
// payload we send + the wire payload we expect back.
//
// If Jerry's actual API uses a different shape, update lib/jerry/client.ts
// to translate; the rest of the integration depends only on these types.

// ── Outbound: meeting context we hand Jerry ─────────────────────────────────

export interface JerryOrgContext {
  orgId: string;
  orgName: string; // FS / BLCS / USA
  orgSlug: string;
}

export interface JerryActorContext {
  personId: string;
  name: string;
  email: string;
  role: "admin" | "member" | "viewer";
}

export interface JerryWeekContext {
  weekId: string;
  weekEndingDate: string;
  quarter: string;
}

export interface JerryMeetingContext {
  /** Next scheduled L10 if any; null when none on the books. */
  nextScheduledFor: string | null;
}

export interface JerryMeasurableSnapshot {
  measurableId: string;
  name: string;
  ownerName: string | null;
  goalDirection: string;
  goalValue: number | null;
  formatHint: string | null;
  /** Current week's actual; null when not entered. */
  currentActual: number | null;
  /** Most recent ~3 prior weeks (oldest-first). */
  history: { weekEndingDate: string; actual: number | null }[];
}

export interface JerryRockSnapshot {
  rockId: string;
  description: string;
  ownerName: string | null;
  status: "on_track" | "off_track" | "still_going" | "completed";
  notes: string | null;
  quarter: string;
}

export interface JerryTodoSnapshot {
  todoId: string;
  description: string;
  ownerName: string | null;
  dueDate: string | null;
  status: "open" | "rolled_over";
  rolloverCount: number;
  notes: string | null;
}

export interface JerryIssueSnapshot {
  issueId: string;
  title: string;
  ownerName: string | null;
  priority: "critical" | "high" | "medium" | "low";
  status: "open" | "ids_in_progress";
  rootCause: string | null;
}

export interface JerryReadinessSnapshot {
  personName: string;
  obligated: boolean;
  status: "red" | "yellow" | "green";
  label: string;
  missingMeasurables: number;
  totalMeasurables: number;
  overdueTodos: number;
}

export interface JerryTranscriptRef {
  transcriptId: string;
  meetingDate: string | null;
  source: "fireflies" | "teams_native" | "transcript_manual";
  durationSec: number | null;
  /** Pointer only — full text is fetched server-side if Jerry asks. */
  hasUtterances: boolean;
}

export interface JerryRequest {
  /** Human prompt from the in-app dock. */
  prompt: string;
  org: JerryOrgContext;
  actor: JerryActorContext;
  week: JerryWeekContext | null;
  meeting: JerryMeetingContext;
  /** Full org-wide board state for the active org + active week. */
  scorecard: JerryMeasurableSnapshot[];
  rocks: JerryRockSnapshot[];
  todos: JerryTodoSnapshot[];
  issues: JerryIssueSnapshot[];
  readiness: JerryReadinessSnapshot[];
  transcripts: JerryTranscriptRef[];
}

// ── Inbound: Jerry's response ──────────────────────────────────────────────
//
// Jerry returns prose + zero-or-more proposed action intents. Intents
// are NOT auto-applied — the user clicks Approve in the dock; the
// /api/jerry/apply route validates auth + applies via existing server
// actions, with audit source "jerry".

export type JerryActionIntent =
  | {
      kind: "update_actual";
      measurableId: string;
      weekId: string;
      actual: string | null;
      note?: string | null;
    }
  | {
      kind: "update_rock_status";
      rockId: string;
      status: "on_track" | "off_track" | "still_going" | "completed";
      note?: string | null;
    }
  | {
      kind: "set_todo_done";
      todoId: string;
      done: boolean;
    }
  | {
      kind: "update_issue_status";
      issueId: string;
      action: "worked" | "push" | "resolved";
    }
  | {
      kind: "create_todo";
      description: string;
      ownerId: string;
      dueDate?: string | null;
      notes?: string | null;
    }
  | {
      kind: "create_issue";
      title: string;
      ownerId: string;
      priority?: "critical" | "high" | "medium" | "low";
      rootCause?: string | null;
    };

export interface JerryCitation {
  /** Stable identifier from Jerry's vault (file path, doc id, etc.). */
  source: string;
  /** Optional snippet preview the dock can render. */
  snippet?: string;
  /** Optional URL or vault path the user can open. */
  href?: string;
}

export interface JerryResponse {
  /** Prose answer rendered in the dock. Adapter maps real Jerry's `answer`. */
  reply: string;
  /** Vault citations Jerry returned. Adapter passes through real Jerry's
   *  `citations` field unchanged in shape. */
  citations?: JerryCitation[];
  /** Optional structured action proposals. UI shows each with Approve/Skip.
   *  Adapter maps a subset of real Jerry's `tool_calls` into this shape;
   *  unmapped tool_calls are surfaced as citations or omitted. */
  actionIntents?: JerryActionIntent[];
  /** Optional model/version stamp Jerry returns for traceability. */
  jerryVersion?: string;
}
