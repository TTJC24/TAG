import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import { fetchCalendarEvents } from './m365/graph.ts';

const SOURCE_ID = 'm365-calendar';
const SOURCE_KIND = 'm365-calendar';
const FIXTURE_PATH = 'fixtures/m365-calendar/events.json';

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  timezone?: string;
  type?: string;
  response?: string;
  organizer?: string;
  location?: string;
  attendees?: string[];
  body_preview?: string | null;
}

function slugFor(ev: CalendarEvent): string {
  const day = ev.start.slice(0, 10);
  const short = computeContentHash(ev.id).slice(0, 10);
  return `calendar/m365/${day}-${short}`;
}

function sourceUri(ev: CalendarEvent): string {
  return `m365-calendar://event/${encodeURIComponent(ev.id)}`;
}

function cleanPreview(preview: string | null | undefined): string {
  if (!preview) return '';
  return preview
    .replace(/https:\/\/teams\.microsoft\.com\/\S+/gi, '[Teams link redacted]')
    .replace(/\bPasscode:\s*\S+/gi, 'Passcode: [redacted]')
    .replace(/\bMeeting ID:\s*[\d\s]+/gi, 'Meeting ID: [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function markdownFor(ev: CalendarEvent): string {
  const attendees = ev.attendees?.length ? ev.attendees.join(', ') : 'None listed';
  const preview = cleanPreview(ev.body_preview);
  return `---
type: note
title: "${ev.subject.replaceAll('"', '\\"')}"
calendar_event_id: "${ev.id.replaceAll('"', '\\"')}"
source_uri: "${sourceUri(ev)}"
source_kind: "${SOURCE_KIND}"
event_start: "${ev.start}"
event_end: "${ev.end}"
event_timezone: "${ev.timezone ?? 'UTC'}"
event_response: "${ev.response ?? ''}"
event_type: "${ev.type ?? ''}"
---

# ${ev.subject}

- Source: ${sourceUri(ev)}
- Start: ${ev.start} ${ev.timezone ?? 'UTC'}
- End: ${ev.end} ${ev.timezone ?? 'UTC'}
- Organizer: ${ev.organizer ?? 'Unknown'}
- Location: ${ev.location ?? ''}
- Response: ${ev.response ?? ''}
- Attendees: ${attendees}

${preview ? `## Body Preview\n\n${preview}\n` : ''}
`;
}

class M365CalendarSource implements IngestionSource {
  readonly id = SOURCE_ID;
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(private readonly events: CalendarEvent[]) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    for (const ev of this.events) {
      const content = markdownFor(ev);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(ev),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(ev),
          event_id: ev.id,
          event_start: ev.start,
          event_end: ev.end,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadEvents(dryRun: boolean): Promise<CalendarEvent[]> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CalendarEvent[];
  }
  return await fetchCalendarEvents();
}

export const m365CalendarConnector: ConnectorSpec = {
  id: SOURCE_ID,
  displayName: 'M365 Calendar',
  kind: SOURCE_KIND,
  async build({ dryRun }) {
    const events = await loadEvents(dryRun);
    return new M365CalendarSource(events);
  },
};
