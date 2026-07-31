/**
 * Daily feed refresh scheduling.
 *
 * The doorways were only ever refreshed by a human running a CLI, which is the
 * difference between "a system" and "a thing someone remembers to poke". This
 * decides WHEN a feed is due; it does not decide what a feed does, and it never
 * runs anything itself — the worker owns execution.
 *
 * Deliberately a pure, testable clock function rather than a cron dependency:
 * the worker already has a poll loop, so "is it due?" is all that's missing.
 *
 * Posture: ships inert. With no COLLECTIONS_SCHEDULE / SALES_SCHEDULE set,
 * resolveFeedSchedules() returns nothing and the worker's behaviour is
 * unchanged. Scheduling a pull is a read-refresh only — it raises governed
 * issues exactly as the manual CLI does, and sends nothing.
 */

export interface FeedSchedule {
  /** Stable name, used for the run marker and the log line. */
  name: string;
  /**
   * Hour (0-23) **in UTC**, not local time. Fixed in UTC means the pull does
   * not follow daylight-saving changes: a schedule set for 07:00 ET in winter
   * arrives at 06:00 ET in summer. Pick the hour with that hour of slack.
   */
  hourUtc: number;
  /** Minute (0-59), UTC. */
  minuteUtc: number;
}

export interface FeedScheduleEnv {
  /** "HH:MM" in UTC, e.g. "11:00". Unset means the feed is not scheduled. */
  COLLECTIONS_SCHEDULE_UTC?: string;
  SALES_SCHEDULE_UTC?: string;
  /**
   * Second, independent interlock on the ONE scheduled feed that authenticates
   * against Acumatica. Must be exactly "true" or collections is never
   * scheduled, whatever COLLECTIONS_SCHEDULE_UTC says.
   *
   * Two switches rather than one because they answer different questions.
   * The schedule says *when* the feed would run; this says whether unattended
   * ERP authentication is permitted at all. During controlled production
   * validation the answer is no, and it must stay no even if somebody restores
   * a schedule time from an old .env while chasing something unrelated.
   *
   * Sales (Pipedrive) is not gated: it uses an API token with no lockout
   * policy and was never implicated.
   */
  ACUMATICA_UNATTENDED_ENABLED?: string;
}

/** Parse "HH:MM" into hour/minute, or null when absent or malformed. */
export function parseScheduleTime(
  value: string | undefined,
): { hourUtc: number; minuteUtc: number } | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hourUtc = Number.parseInt(match[1]!, 10);
  const minuteUtc = Number.parseInt(match[2]!, 10);
  if (hourUtc < 0 || hourUtc > 23 || minuteUtc < 0 || minuteUtc > 59) {
    return null;
  }
  return { hourUtc, minuteUtc };
}

/**
 * Which feeds are scheduled, from the environment. An unset or malformed time
 * means "not scheduled" — a bad value must never silently become midnight.
 */
export function resolveFeedSchedules(
  env: FeedScheduleEnv = process.env as FeedScheduleEnv,
): FeedSchedule[] {
  const schedules: FeedSchedule[] = [];
  const collections = parseScheduleTime(env.COLLECTIONS_SCHEDULE_UTC);
  // Fails closed: anything other than the exact string "true" leaves the
  // Acumatica feed unscheduled. A missing variable, a typo, "TRUE", "1" and
  // "yes" all mean no.
  const unattendedPermitted = env.ACUMATICA_UNATTENDED_ENABLED === "true";
  if (collections && unattendedPermitted) {
    schedules.push({ name: "collections", ...collections });
  }
  const sales = parseScheduleTime(env.SALES_SCHEDULE_UTC);
  if (sales) schedules.push({ name: "sales", ...sales });
  return schedules;
}

/** The UTC date key ("YYYY-MM-DD") a run is counted against. */
export function runDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Is this feed due right now, given when it last ran?
 *
 * "Due" means: we are at or past today's scheduled time, and we have not
 * already run today. Comparing against a date key rather than an elapsed
 * interval is what makes a restart safe — a worker that restarts five times
 * between 11:00 and 11:05 still pulls once, and a worker that was down at
 * 11:00 and comes up at 13:00 still gets the day's pull rather than skipping it.
 */
export function isFeedDue(
  schedule: FeedSchedule,
  now: Date,
  lastRunDateKey: string | null,
): boolean {
  const today = runDateKey(now);
  if (lastRunDateKey === today) return false;
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const minutesDue = schedule.hourUtc * 60 + schedule.minuteUtc;
  return minutesNow >= minutesDue;
}

/**
 * In-memory record of which feeds have run today. The worker is a single
 * long-lived process, so this is sufficient to make the daily pull idempotent
 * within a run; intake itself is idempotent per aging date, so a duplicate
 * pull after a restart replays rather than double-raising chases.
 */
export class FeedRunLog {
  private readonly lastRunByFeed = new Map<string, string>();

  lastRun(feedName: string): string | null {
    return this.lastRunByFeed.get(feedName) ?? null;
  }

  record(feedName: string, now: Date): void {
    this.lastRunByFeed.set(feedName, runDateKey(now));
  }

  /** Feeds due at this instant, in declaration order. */
  due(schedules: FeedSchedule[], now: Date): FeedSchedule[] {
    return schedules.filter((schedule) =>
      isFeedDue(schedule, now, this.lastRun(schedule.name)),
    );
  }
}
