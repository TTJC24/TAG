import { describe, expect, it } from "vitest";
import {
  evaluateApprovalPolicy,
  isIssueIntakeTransitionAllowed,
} from "@operating-layer/workflows";

describe("Phase 1 approval policy", () => {
  it("allows low-risk internal work without approval", () => {
    expect(
      evaluateApprovalPolicy({
        riskLevel: 2,
        requestedAction: "create_internal_follow_up",
      }),
    ).toMatchObject({
      allowedInPhase: true,
      requiresApproval: false,
    });
  });

  it("requires approval for an external-message draft and prohibits writes", () => {
    expect(
      evaluateApprovalPolicy({
        riskLevel: 4,
        requestedAction: "draft_external_follow_up",
      }),
    ).toMatchObject({
      allowedInPhase: true,
      requiresApproval: true,
    });
    expect(
      evaluateApprovalPolicy({
        riskLevel: 5,
        requestedAction: "erp_write",
      }),
    ).toMatchObject({
      allowedInPhase: false,
      requiresApproval: true,
    });
  });
});

describe("issue-intake transition graph", () => {
  it("permits the approved path and rejects shortcuts", () => {
    expect(isIssueIntakeTransitionAllowed("received", "normalized")).toBe(true);
    expect(isIssueIntakeTransitionAllowed("normalized", "classified")).toBe(
      true,
    );
    expect(isIssueIntakeTransitionAllowed("received", "completed")).toBe(false);
    expect(
      isIssueIntakeTransitionAllowed("awaiting_approval", "completed"),
    ).toBe(false);
  });
});
