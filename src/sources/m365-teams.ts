import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import { fetchTeamsThreads } from './m365/graph.ts';

const SOURCE_ID = 'm365-teams';
const SOURCE_KIND = 'm365-teams';
const FIXTURE_PATH = 'fixtures/m365-teams/threads.json';

export interface TeamsThread {
  id: string;
  team_id: string;
  team_name: string;
  channel_id: string;
  channel_name: string;
  channel_web_url: string;
  author: string;
  created_at: string;
  body: string;
  body_content_type: string;
  reply_to_id: string | null;
}

function slugFor(t: TeamsThread): string {
  const day = t.created_at.slice(0, 10);
  const short = computeContentHash(t.id).slice(0, 10);
  return `teams/m365/${day}-${short}`;
}

function sourceUri(t: TeamsThread): string {
  return `m365-teams://team/${encodeURIComponent(t.team_id)}/channel/${encodeURIComponent(t.channel_id)}/message/${encodeURIComponent(t.id)}`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function markdownFor(t: TeamsThread): string {
  const body = t.body_content_type === 'html' ? stripHtml(t.body) : t.body;
  return `---
type: note
title: "${(t.team_name + ' / ' + t.channel_name).replaceAll('"', '\\"')}"
teams_message_id: "${t.id.replaceAll('"', '\\"')}"
source_uri: "${sourceUri(t)}"
source_kind: "${SOURCE_KIND}"
team_name: "${t.team_name.replaceAll('"', '\\"')}"
channel_name: "${t.channel_name.replaceAll('"', '\\"')}"
author: "${t.author.replaceAll('"', '\\"')}"
created_at: "${t.created_at}"
reply_to_id: "${t.reply_to_id ?? ''}"
---

# ${t.team_name} / ${t.channel_name}

- Source: ${sourceUri(t)}
- Channel web link: ${t.channel_web_url}
- Author: ${t.author}
- Created: ${t.created_at}
${t.reply_to_id ? `- In reply to: ${t.reply_to_id}` : ''}

${body ? `## Message\n\n${body.slice(0, 4000)}\n` : ''}
`;
}

class M365TeamsSource implements IngestionSource {
  readonly id = SOURCE_ID;
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(private readonly threads: TeamsThread[]) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    for (const t of this.threads) {
      const content = markdownFor(t);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(t),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(t),
          message_id: t.id,
          channel_id: t.channel_id,
          team_id: t.team_id,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadThreads(dryRun: boolean): Promise<TeamsThread[]> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as TeamsThread[];
  }
  return await fetchTeamsThreads();
}

export const m365TeamsConnector: ConnectorSpec = {
  id: SOURCE_ID,
  displayName: 'M365 Teams',
  kind: SOURCE_KIND,
  async build({ dryRun }) {
    const threads = await loadThreads(dryRun);
    return new M365TeamsSource(threads);
  },
};
