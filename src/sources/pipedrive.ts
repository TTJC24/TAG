import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import { fetchPipedriveSnapshot } from './pipedrive/client.ts';
import { config } from '../config.ts';

const SOURCE_ID = 'pipedrive';
const SOURCE_KIND = 'pipedrive';
const FIXTURE_PATH = 'fixtures/pipedrive/snapshot.json';

export type PipedriveEntityKind = 'deal' | 'person' | 'organization' | 'activity' | 'note';

export interface PipedriveEntity {
  kind: PipedriveEntityKind;
  id: string;
  name: string;
  updated_at: string;
  body: Record<string, unknown>;
  related?: {
    notes?: Array<{ id: string; content: string }>;
    activities?: Array<{ id: string; subject: string; type?: string; done?: boolean }>;
  };
}

export interface PipedriveSnapshot {
  deals: PipedriveEntity[];
  persons: PipedriveEntity[];
  organizations: PipedriveEntity[];
  activities: PipedriveEntity[];
  notes: PipedriveEntity[];
}

// Slugs and source URIs are scoped by the source instance id. Pipedrive's
// numeric ids are namespaced PER ACCOUNT — deal `12001` in pipedrive-fs is
// a different deal from `12001` in pipedrive-blcs-usa. Without the source-id
// prefix, both ingests produced the same `pipedrive/deal/12001-<hash>` slug,
// and the second connector's pages either silently replaced or were skipped
// by the page-storage layer — that's how BLCS+USA reported 0/1231 imported
// behind FS.
function slugFor(sourceId: string, e: PipedriveEntity): string {
  const short = computeContentHash(`${sourceId}/${e.kind}/${e.id}`).slice(0, 10);
  return `${sourceId}/${e.kind}/${e.id}-${short}`;
}

function sourceUri(sourceId: string, e: PipedriveEntity): string {
  return `${sourceId}://${e.kind}/${encodeURIComponent(e.id)}`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderBody(body: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      lines.push(`- **${k}**: ${JSON.stringify(v).slice(0, 400)}`);
    } else {
      lines.push(`- **${k}**: ${String(v).slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

function renderRelated(e: PipedriveEntity): string {
  const sections: string[] = [];
  if (e.related?.notes?.length) {
    sections.push('## Notes\n\n' + e.related.notes.map((n) => `- ${stripHtml(n.content).slice(0, 400)}`).join('\n'));
  }
  if (e.related?.activities?.length) {
    sections.push(
      '## Activities\n\n' +
        e.related.activities
          .map((a) => `- [${a.done ? 'x' : ' '}] ${a.subject}${a.type ? ` _(${a.type})_` : ''}`)
          .join('\n'),
    );
  }
  return sections.join('\n\n');
}

function markdownFor(sourceId: string, e: PipedriveEntity): string {
  return `---
type: note
title: "${e.name.replaceAll('"', '\\"')}"
pipedrive_id: "${e.id}"
pipedrive_kind: "${e.kind}"
source_uri: "${sourceUri(sourceId, e)}"
source_kind: "${SOURCE_KIND}"
updated_at: "${e.updated_at}"
---

# ${e.name}

- Source: ${sourceUri(sourceId, e)}
- Kind: ${e.kind}
- Updated: ${e.updated_at || '(unknown)'}

## Fields

${renderBody(e.body)}

${renderRelated(e)}
`;
}

class PipedriveSource implements IngestionSource {
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(readonly id: string, private readonly snapshot: PipedriveSnapshot) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    const all = [
      ...this.snapshot.deals,
      ...this.snapshot.persons,
      ...this.snapshot.organizations,
      ...this.snapshot.activities,
      ...this.snapshot.notes,
    ];
    for (const e of all) {
      const content = markdownFor(this.id, e);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(this.id, e),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(this.id, e),
          entity_kind: e.kind,
          entity_id: e.id,
          updated_at: e.updated_at,
          // v3 freshness contract: explicit upstream timestamp, null when
          // upstream did not carry update_time or add_time.
          upstream_updated_at: e.updated_at || null,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadSnapshot(dryRun: boolean, apiToken?: string): Promise<PipedriveSnapshot> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PipedriveSnapshot;
  }
  return await fetchPipedriveSnapshot({ apiToken });
}

export function createPipedriveConnector(id = SOURCE_ID, displayName = 'Pipedrive CRM', tokenEnv?: 'PIPEDRIVE_API_TOKEN_FS' | 'PIPEDRIVE_API_TOKEN_BLCS_USA'): ConnectorSpec {
  return {
    id,
    displayName,
    kind: SOURCE_KIND,
    fixturePath: FIXTURE_PATH,
    requiredEnv: ['PIPEDRIVE_COMPANY_DOMAIN', ...(tokenEnv ? [tokenEnv] : ['PIPEDRIVE_API_TOKEN'])],
    async build({ dryRun }) {
      const snapshot = await loadSnapshot(dryRun, tokenEnv ? config[tokenEnv] : undefined);
      return new PipedriveSource(id, snapshot);
    },
  };
}

export const pipedriveConnector: ConnectorSpec = createPipedriveConnector();
