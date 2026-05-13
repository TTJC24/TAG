import { describe, expect, it } from "vitest";
import { computeReadiness } from "./compute-readiness";

const M = (id: string, currentActual: number | null) => ({
  measurableId: id,
  currentActual,
});
const T = (id: string, dueDate: string | null) => ({ todoId: id, dueDate });

describe("computeReadiness", () => {
  it("green when nothing is assigned", () => {
    const r = computeReadiness({
      measurables: [],
      openTodos: [],
      today: "2026-05-13",
    });
    expect(r.status).toBe("green");
    expect(r.label).toBe("Nothing assigned");
    expect(r.totalMeasurables).toBe(0);
  });

  it("green when everything is filled and nothing overdue", () => {
    const r = computeReadiness({
      measurables: [M("a", 100), M("b", 0)],
      openTodos: [T("t1", "2026-05-20")],
      today: "2026-05-13",
    });
    expect(r.status).toBe("green");
    expect(r.label).toBe("Ready for L10");
    expect(r.missingMeasurables).toBe(0);
    expect(r.overdueTodos).toBe(0);
  });

  it("zero is a real number, not 'missing'", () => {
    const r = computeReadiness({
      measurables: [M("a", 0)],
      openTodos: [],
      today: "2026-05-13",
    });
    expect(r.status).toBe("green");
    expect(r.missingMeasurables).toBe(0);
  });

  it("red when at least one measurable is missing", () => {
    const r = computeReadiness({
      measurables: [M("a", 100), M("b", null)],
      openTodos: [T("t1", "2026-05-01")], // overdue too, but red wins
      today: "2026-05-13",
    });
    expect(r.status).toBe("red");
    expect(r.label).toBe("1 measurable missing");
    expect(r.missingMeasurables).toBe(1);
    expect(r.overdueTodos).toBe(1);
  });

  it("pluralizes measurable copy", () => {
    const r = computeReadiness({
      measurables: [M("a", null), M("b", null), M("c", 5)],
      openTodos: [],
      today: "2026-05-13",
    });
    expect(r.label).toBe("2 measurables missing");
  });

  it("yellow when only overdue to-dos exist", () => {
    const r = computeReadiness({
      measurables: [M("a", 1)],
      openTodos: [T("t1", "2026-05-01"), T("t2", "2026-05-12")],
      today: "2026-05-13",
    });
    expect(r.status).toBe("yellow");
    expect(r.label).toBe("2 overdue to-dos");
    expect(r.overdueTodos).toBe(2);
  });

  it("a to-do due today is not overdue", () => {
    const r = computeReadiness({
      measurables: [M("a", 1)],
      openTodos: [T("t1", "2026-05-13")],
      today: "2026-05-13",
    });
    expect(r.status).toBe("green");
    expect(r.overdueTodos).toBe(0);
  });

  it("a to-do with no due date is never overdue", () => {
    const r = computeReadiness({
      measurables: [M("a", 1)],
      openTodos: [T("t1", null)],
      today: "2026-05-13",
    });
    expect(r.status).toBe("green");
    expect(r.overdueTodos).toBe(0);
  });

  it("singular pluralization for one overdue todo", () => {
    const r = computeReadiness({
      measurables: [M("a", 1)],
      openTodos: [T("t1", "2026-05-12")],
      today: "2026-05-13",
    });
    expect(r.label).toBe("1 overdue to-do");
  });
});
