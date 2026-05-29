import { redirect } from "next/navigation";
import { AuthContextError, getAuthContext } from "@/lib/auth/context";
import { getLiveMeeting, getNextMeeting } from "@/lib/queries/me";
import { MeetingAgenda, type AgendaSegment } from "@/components/meeting-agenda";
import { SurfaceHeader, StatNumber } from "@/components/ui/surface-header";

export const dynamic = "force-dynamic";

// The fixed L10 agenda (docs/meeting-flow.md). 95 base + 25 slack = 120.
const AGENDA: AgendaSegment[] = [
  { key: "segue", name: "Segue", minutes: 5, href: null, desc: "Personal & professional good news." },
  { key: "scorecard", name: "Scorecard Review", minutes: 10, href: "/scorecard", desc: "Review measurables; flag red & off-trend." },
  { key: "rock", name: "Rock Review", minutes: 5, href: "/rocks", desc: "On-track / off-track per owner." },
  { key: "headlines", name: "Headlines", minutes: 5, href: null, desc: "Customer & employee headlines." },
  { key: "todo", name: "To-Do Review", minutes: 5, href: "/todos", desc: "Done / not done; carry forward." },
  { key: "ids", name: "IDS", minutes: 60, href: "/issues", desc: "Identify, Discuss, Solve the issues list." },
  { key: "conclude", name: "Conclude", minutes: 5, href: null, desc: "Recap, cascading messages, per-attendee rating." },
];

function formatMeetingDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default async function MeetingPage() {
  let ctx;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof AuthContextError && err.reason === "no_active_org") {
      redirect("/");
    }
    throw err;
  }

  const [liveMeeting, nextMeeting] = await Promise.all([
    getLiveMeeting(ctx.orgId),
    getNextMeeting(ctx.orgId),
  ]);

  const total = AGENDA.reduce((s, x) => s + x.minutes, 0);
  const sub = liveMeeting
    ? "live now"
    : nextMeeting
      ? `next L10 · ${formatMeetingDate(nextMeeting.scheduledFor)}`
      : "no L10 scheduled";

  return (
    <main className="container space-y-7 py-7">
      <SurfaceHeader eyebrow={`${ctx.orgName} · weekly leadership meeting`} title="L10 Meeting" sub={sub}>
        <StatNumber value={AGENDA.length} label="segments" hero />
        <StatNumber value={`${total}`} label="minutes" tone="muted" />
      </SurfaceHeader>

      <MeetingAgenda
        segments={AGENDA}
        startedAtMs={liveMeeting ? liveMeeting.scheduledFor.getTime() : null}
      />
    </main>
  );
}
