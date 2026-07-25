import { describe, expect, it } from "vitest";
import {
  evaluateDeclarativeApprovalPolicy,
  evaluateApprovalPolicy,
  evaluatePhase1ApprovalPolicy,
  isIssueIntakeTransitionAllowed,
  type DeclarativeApprovalPolicyInput,
  type DeclarativeApprovalPolicyVersion,
} from "@operating-layer/workflows";

const organizationId = "10000000-0000-4000-8000-000000000001";
const declarativePolicy: DeclarativeApprovalPolicyVersion = {
  id: "62000000-0000-4000-8000-000000000001",
  organizationId,
  policyKey: "issue_intake",
  versionNumber: 1,
  schemaVersion: "approval-policy.v1",
  humanLabel: "phase1-v1-data",
  contentHash: "a".repeat(64),
  rules: [
    {
      id: "64000000-0000-4000-8000-000000000001",
      ordinal: 10,
      name: "Risk 6 prohibited",
      predicate: {
        field: "recommendation.risk_level",
        operator: "gte",
        value: 6,
      },
      outcome: {
        effect: "blocked",
        approverCount: 0,
        approverPermission: null,
        requesterMustBeDistinct: true,
        approversMustBeDistinct: true,
      },
      reasonCode: "risk_6_prohibited",
    },
    {
      id: "64000000-0000-4000-8000-000000000002",
      ordinal: 20,
      name: "Risk 5 write prohibited",
      predicate: {
        field: "recommendation.risk_level",
        operator: "eq",
        value: 5,
      },
      outcome: {
        effect: "blocked",
        approverCount: 0,
        approverPermission: null,
        requesterMustBeDistinct: true,
        approversMustBeDistinct: true,
      },
      reasonCode: "risk_5_write_prohibited_in_phase1",
    },
    {
      id: "64000000-0000-4000-8000-000000000003",
      ordinal: 30,
      name: "Risk 3 and 4 require approval",
      predicate: {
        all: [
          {
            field: "recommendation.risk_level",
            operator: "gte",
            value: 3,
          },
          {
            field: "recommendation.risk_level",
            operator: "lte",
            value: 4,
          },
        ],
      },
      outcome: {
        effect: "requires_approval",
        approverCount: 1,
        approverPermission: "approvals.decide",
        requesterMustBeDistinct: true,
        approversMustBeDistinct: true,
      },
      reasonCode: "human_approval_required",
    },
    {
      id: "64000000-0000-4000-8000-000000000004",
      ordinal: 40,
      name: "Low-risk default",
      predicate: { all: [] },
      outcome: {
        effect: "auto_approve",
        approverCount: 0,
        approverPermission: null,
        requesterMustBeDistinct: false,
        approversMustBeDistinct: false,
      },
      reasonCode: "low_risk_internal_action",
    },
  ],
};

function declarativeInput(riskLevel: number): DeclarativeApprovalPolicyInput {
  return {
    task: {
      organizationId,
      taskType: "collections",
    },
    recommendation: {
      riskLevel,
      recommendationType: "draft_external_follow_up",
    },
    requestedAction: {
      actionType: "draft_external_follow_up",
      targetSystem: "internal_approval_only",
      crossEntity: false,
    },
  };
}

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

  it("proves the seeded declarative rules are behaviorally equivalent to phase1-v1", () => {
    for (const riskLevel of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const legacy = evaluatePhase1ApprovalPolicy({
        riskLevel,
        requestedAction: "draft_external_follow_up",
      });
      const declarative = evaluateDeclarativeApprovalPolicy(
        declarativeInput(riskLevel),
        declarativePolicy,
      );
      expect({
        allowedInPhase: declarative.allowedInPhase,
        requiresApproval: declarative.requiresApproval,
        reasonCode: declarative.reasonCode,
      }).toEqual({
        allowedInPhase: legacy.allowedInPhase,
        requiresApproval: legacy.requiresApproval,
        reasonCode: legacy.reasonCode,
      });
    }

    expect(() =>
      evaluatePhase1ApprovalPolicy({
        riskLevel: -1,
        requestedAction: "invalid",
      }),
    ).toThrow("Invalid risk level");
    expect(() =>
      evaluateDeclarativeApprovalPolicy(
        declarativeInput(-1),
        declarativePolicy,
      ),
    ).toThrow("Invalid risk level");
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
    expect(
      isIssueIntakeTransitionAllowed("awaiting_approval", "approved"),
    ).toBe(true);
    expect(isIssueIntakeTransitionAllowed("approved", "completed")).toBe(true);
    expect(
      isIssueIntakeTransitionAllowed("awaiting_approval", "rejected"),
    ).toBe(true);
  });
});
