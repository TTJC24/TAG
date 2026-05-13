// We exercise the channel orchestration logic by stubbing the channels.
// The DB-touching parts (getOrgReadiness + getNextMeeting) are exercised
// via integration tests; here we focus on the deterministic policy:
//   - green people are skipped
//   - dry-run never invokes send()
//   - disabled channels record a "channel disabled" receipt
//   - a channel that throws records the reason and never aborts the run

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NudgeChannel } from "./types";

vi.mock("@/lib/queries/org-readiness", () => ({
  getOrgReadiness: vi.fn(),
}));
vi.mock("@/lib/queries/me", () => ({
  getNextMeeting: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ weeks: {} }));
vi.mock("drizzle-orm", () => ({ desc: vi.fn() }));

import { dispatchNudges } from "./dispatch";
import { getOrgReadiness } from "@/lib/queries/org-readiness";
import { getNextMeeting } from "@/lib/queries/me";

const orgReadinessMock = vi.mocked(getOrgReadiness);
const nextMeetingMock = vi.mocked(getNextMeeting);

class StubChannel implements NudgeChannel {
  constructor(
    public readonly name: string,
    private readonly enabled: boolean,
    private readonly behavior: "ok" | "throw" = "ok",
  ) {}
  public sends = 0;
  isEnabled() {
    return this.enabled;
  }
  async send() {
    this.sends += 1;
    if (this.behavior === "throw") throw new Error("upstream 500");
    return { channel: this.name, delivered: true, externalId: "x1" };
  }
}

const person = (id: string, name: string) => ({
  id,
  name,
  email: `${id}@example.com`,
  avatarUrl: null,
  role: "member" as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  nextMeetingMock.mockResolvedValue(null);
  // The dispatch helper does its own current-week lookup; we short-circuit
  // it by stubbing the post-week query.
  orgReadinessMock.mockResolvedValue([
    {
      person: person("p1", "Red Rider"),
      readiness: {
        status: "red",
        label: "1 measurable missing",
        totalMeasurables: 2,
        missingMeasurables: 1,
        overdueTodos: 0,
      },
    },
    {
      person: person("p2", "Green Goose"),
      readiness: {
        status: "green",
        label: "Ready for L10",
        totalMeasurables: 2,
        missingMeasurables: 0,
        overdueTodos: 0,
      },
    },
  ]);
});

// We don't care about the inner week lookup for these tests — stub the
// dispatch's own DB module.
vi.mock("@/lib/db/client", async () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    },
  };
});

describe("dispatchNudges", () => {
  it("skips green people and composes for red/yellow", async () => {
    const inApp = new StubChannel("in_app", true);
    const result = await dispatchNudges({
      orgId: "org-fs",
      orgSlug: "fs",
      window: "sunday_evening",
      channels: [inApp],
      today: "2026-05-13",
    });
    expect(result.nudges).toHaveLength(1);
    expect(result.nudges[0]!.nudge.recipientPersonId).toBe("p1");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.personId).toBe("p2");
    expect(inApp.sends).toBe(1);
  });

  it("dry-run never invokes send()", async () => {
    const inApp = new StubChannel("in_app", true);
    const result = await dispatchNudges({
      orgId: "org-fs",
      orgSlug: "fs",
      window: "sunday_evening",
      dryRun: true,
      channels: [inApp],
      today: "2026-05-13",
    });
    expect(inApp.sends).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.nudges[0]!.receipts[0]!.delivered).toBe(false);
    expect(result.nudges[0]!.receipts[0]!.reason).toBe("dry run");
  });

  it("records 'channel disabled' for outbound channels still gated off", async () => {
    const inApp = new StubChannel("in_app", true);
    const teams = new StubChannel("teams", false);
    const resend = new StubChannel("resend", false);
    const result = await dispatchNudges({
      orgId: "org-fs",
      orgSlug: "fs",
      window: "monday_morning",
      channels: [inApp, teams, resend],
      today: "2026-05-13",
    });
    const r = result.nudges[0]!.receipts;
    expect(r.find((x) => x.channel === "in_app")!.delivered).toBe(true);
    expect(r.find((x) => x.channel === "teams")!.delivered).toBe(false);
    expect(r.find((x) => x.channel === "teams")!.reason).toBe("channel disabled");
    expect(r.find((x) => x.channel === "resend")!.delivered).toBe(false);
    expect(teams.sends).toBe(0);
    expect(resend.sends).toBe(0);
  });

  it("a thrown channel error never aborts the dispatch", async () => {
    const inApp = new StubChannel("in_app", true);
    const flaky = new StubChannel("teams", true, "throw");
    const result = await dispatchNudges({
      orgId: "org-fs",
      orgSlug: "fs",
      window: "sunday_evening",
      channels: [inApp, flaky],
      today: "2026-05-13",
    });
    const teamsReceipt = result.nudges[0]!.receipts.find(
      (r) => r.channel === "teams",
    );
    expect(teamsReceipt!.delivered).toBe(false);
    expect(teamsReceipt!.reason).toBe("upstream 500");
    // in_app still delivered.
    const inAppReceipt = result.nudges[0]!.receipts.find(
      (r) => r.channel === "in_app",
    );
    expect(inAppReceipt!.delivered).toBe(true);
  });

  it("snapshots channel state in the result", async () => {
    const inApp = new StubChannel("in_app", true);
    const teams = new StubChannel("teams", false);
    const result = await dispatchNudges({
      orgId: "org-fs",
      orgSlug: "fs",
      window: "pre_meeting",
      channels: [inApp, teams],
      today: "2026-05-13",
    });
    expect(result.channels).toEqual([
      { name: "in_app", enabled: true },
      { name: "teams", enabled: false },
    ]);
  });
});
