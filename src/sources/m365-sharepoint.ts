import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import { fetchSharePointItems } from './m365/graph.ts';

const SOURCE_ID = 'm365-sharepoint';
const SOURCE_KIND = 'm365-sharepoint';
const FIXTURE_PATH = 'fixtures/m365-sharepoint/items.json';

export interface SharePointItem {
  id: string;
  site_id: string;
  site_name: string;
  drive_id: string;
  drive_name: string;
  name: string;
  web_url: string;
  size: number;
  mime_type: string;
  last_modified: string;
  modified_by: string;
  content_text?: string | null;
}

function slugFor(it: SharePointItem): string {
  // v3 freshness contract: slug needs a date prefix for chronological ordering
  // even when upstream last_modified is unknown. Fall back to today's date for
  // the slug ONLY; the emitted metadata.upstream_updated_at stays honestly
  // null so downstream surfaces (page generator, search index) render
  // "freshness unknown" instead of today's date.
  const day = (it.last_modified || new Date().toISOString()).slice(0, 10);
  const short = computeContentHash(it.id).slice(0, 10);
  return `sharepoint/m365/${day}-${short}`;
}

function sourceUri(it: SharePointItem): string {
  return `m365-sharepoint://drive/${encodeURIComponent(it.drive_id)}/item/${encodeURIComponent(it.id)}`;
}

function cleanExtractedText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownFor(it: SharePointItem): string {
  const extracted = it.content_text ? cleanExtractedText(it.content_text) : '';
  return `---
type: note
title: "${it.name.replaceAll('"', '\\"')}"
sharepoint_item_id: "${it.id.replaceAll('"', '\\"')}"
source_uri: "${sourceUri(it)}"
source_kind: "${SOURCE_KIND}"
site_name: "${it.site_name.replaceAll('"', '\\"')}"
drive_name: "${it.drive_name.replaceAll('"', '\\"')}"
mime_type: "${it.mime_type}"
last_modified: "${it.last_modified}"
---

# ${it.name}

- Source: ${sourceUri(it)}
- Site: ${it.site_name}
- Drive: ${it.drive_name}
- Web URL: ${it.web_url}
- Size: ${it.size} bytes
- MIME: ${it.mime_type}
- Last modified: ${it.last_modified || '(unknown)'} by ${it.modified_by || '(unknown)'}

${extracted ? `## Extracted Content\n\n${extracted.slice(0, 12000)}\n` : '> No plain-text body was available for this file; metadata and the web URL were indexed.'}
`;
}

class M365SharePointSource implements IngestionSource {
  readonly id = SOURCE_ID;
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(private readonly items: SharePointItem[]) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    for (const it of this.items) {
      const content = markdownFor(it);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(it),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(it),
          item_id: it.id,
          drive_id: it.drive_id,
          last_modified: it.last_modified,
          // v3 freshness contract: explicit upstream timestamp, null when
          // Graph did not report lastModifiedDateTime. Prefer this over
          // `last_modified` (which is "" when unknown for backward-compat)
          // and over received_at (which is wall-clock ingest time).
          upstream_updated_at: it.last_modified || null,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadItems(dryRun: boolean): Promise<SharePointItem[]> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SharePointItem[];
  }
  return await fetchSharePointItems();
}

export const m365SharePointConnector: ConnectorSpec = {
  id: SOURCE_ID,
  displayName: 'M365 SharePoint',
  kind: SOURCE_KIND,
  fixturePath: FIXTURE_PATH,
  requiredEnv: ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET'],
  async build({ dryRun }) {
    const items = await loadItems(dryRun);
    return new M365SharePointSource(items);
  },
};
