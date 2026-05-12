// Shading engine types.
//
// The engine is a pure function over a small projection of the DB entry,
// the parent measurable's goal definition, and the chronological history
// of prior entries. Tests in compute-status.test.ts pin every branch.

export type StatusColor = "green" | "yellow" | "red";

export type GoalDirection =
  | "gte"
  | "lte"
  | "eq"
  | "between"
  | "trend_down"
  | "trend_up";

export type NoteClassification =
  | "explained_one_off"
  | "structural_issue"
  | "on_plan_to_recover"
  | "no_context";

export interface ShadingMeasurable {
  goalDirection: GoalDirection;
  goalValue: number | null;
  goalSecondary: number | null;
}

export interface ShadingEntry {
  actual: number | null;
  noteClassification?: NoteClassification | null;
  statusOverride?: StatusColor | null;
}

export interface ShadingResult {
  status: StatusColor;
  /** 0..100 — drives `background-color: hsl(var(--status-X) / intensity%)`. */
  intensity: number;
  /** Human-readable explanation surfaced on hover. */
  reason: string;
  /** When set, the cell gets a warning border even if status is green. */
  forecast: "warning" | null;
}
