// Pure helper that turns the data already loaded for /me into a "ready for
// the upcoming L10?" verdict. No DB access — pass in what the page already
// fetched so this stays cheap and easy to unit-test.
//
// What "ready" means for an owner viewing /me:
//   1. They have an `actual` entered for the most-recent week on every
//      measurable they own.
//   2. They have no open to-dos whose dueDate is in the past.
//
// Rocks aren't part of the readiness gate yet — quarterly status changes
// happen during the meeting (Rock Review segment), not pre-meeting. We can
// add them when staleness detection lands.

export type ReadinessStatus = "green" | "yellow" | "red";

export interface ReadinessInput {
  /** All measurables the user owns in the active org. */
  measurables: ReadonlyArray<{
    measurableId: string;
    /** The actual value for the most-recent week, if any. null = missing. */
    currentActual: number | null;
  }>;
  /** Open to-dos owned by the user. */
  openTodos: ReadonlyArray<{
    todoId: string;
    /** ISO yyyy-mm-dd; null when no due date. */
    dueDate: string | null;
  }>;
  /** "Today" as a yyyy-mm-dd string in the caller's timezone. Inject so the
   *  function stays pure and tests don't depend on the wall clock. */
  today: string;
}

export interface ReadinessResult {
  status: ReadinessStatus;
  /** Headline copy for the banner. */
  label: string;
  totalMeasurables: number;
  missingMeasurables: number;
  overdueTodos: number;
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const totalMeasurables = input.measurables.length;
  const missingMeasurables = input.measurables.filter(
    (m) => m.currentActual === null,
  ).length;
  const overdueTodos = input.openTodos.filter(
    (t) => t.dueDate !== null && t.dueDate < input.today,
  ).length;

  let status: ReadinessStatus;
  let label: string;
  if (missingMeasurables > 0) {
    status = "red";
    label = `${missingMeasurables} measurable${missingMeasurables === 1 ? "" : "s"} missing`;
  } else if (overdueTodos > 0) {
    status = "yellow";
    label = `${overdueTodos} overdue to-do${overdueTodos === 1 ? "" : "s"}`;
  } else {
    status = "green";
    label = totalMeasurables === 0 ? "Nothing assigned" : "Ready for L10";
  }

  return {
    status,
    label,
    totalMeasurables,
    missingMeasurables,
    overdueTodos,
  };
}
