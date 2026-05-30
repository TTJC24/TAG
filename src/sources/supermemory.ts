import { existsSync, readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { ConnectorSpec } from './types.ts';
import {
  containerTagFor,
  listMemories,
  type MemoryScope,
  type SupermemoryDocument,
} from '../memory.ts';

const SOURCE_KIND = 'supermemory';

/** One container per entity, plus the cross-entity shared container. */
const SCOPES: readonly MemoryScope[] = ['fs', 'blcs', 'usa', 'shared'];

const DISPLAY_NAMES: Record<MemoryScope, string> = {
  fs: 'Supermemory (Fastening Specialists)',
  blcs: 'Supermemory (Big League Construction Supply)',
  usa: 'Supermemory (Utility Supply Associates)',
  shared: 'Supermemory (Shared)',
};

function sourceIdFor(scope: MemoryScope): string {
  return `supermemory-${scope}`;
}

function fixturePath(scope: MemoryScope): string {
  return `fixtures/supermemory/${scope}.json`;
}

function sourceUri(scope: MemoryScope, doc: SupermemoryDocument): string {
  return `supermemory://${containerTagFor(scope)}/${encodeURIComponent(doc.id)}`;
}

function slugFor(scope: MemoryScope, doc: SupermemoryDocument): string {
  const short = computeContentHash(doc.id).slice(0, 10);
  return `supermemory/${scope}/${doc.id}-${short}`;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function markdownFor(scope: MemoryScope, doc: SupermemoryDocument): string {
  const title = doc.title?.trim() || clean(doc.content).slice(0, 80) || doc.id;
  const updated = doc.updatedAt ?? doc.createdAt ?? '';
  return `---
type: note
title: "${title.replaceAll('"', '\\"')}"
supermemory_id: "${doc.id}"
container_tag: "${containerTagFor(scope)}"
entity: "${scope}"
source_uri: "${sourceUri(scope, doc)}"
source_kind: "${SOURCE_KIND}"
updated_at: "${updated}"
---

# ${title}

- Source: ${sourceUri(scope, doc)}
- Entity: ${scope}
${updated ? `- Updated: ${updated}` : ''}

${doc.content}
`;
}

class SupermemorySource implements IngestionSource {
  readonly id: string;
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(
    private readonly scope: MemoryScope,
    private readonly docs: SupermemoryDocument[],
  ) {
    this.id = sourceIdFor(scope);
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    for (const doc of this.docs) {
      if (!doc.content || clean(doc.content).length === 0) continue;
      const content = markdownFor(this.scope, doc);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(this.scope, doc),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(this.scope, doc),
          supermemory_id: doc.id,
          container_tag: containerTagFor(this.scope),
          entity: this.scope,
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadMemories(scope: MemoryScope, dryRun: boolean): Promise<SupermemoryDocument[]> {
  if (dryRun) {
    const path = fixturePath(scope);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as SupermemoryDocument[];
  }
  return await listMemories(scope, { limit: 200 });
}

function connectorFor(scope: MemoryScope): ConnectorSpec {
  return {
    id: sourceIdFor(scope),
    displayName: DISPLAY_NAMES[scope],
    kind: SOURCE_KIND,
    fixturePath: fixturePath(scope),
    requiredEnv: ['SUPERMEMORY_API_KEY'],
    async build({ dryRun }) {
      const docs = await loadMemories(scope, dryRun);
      return new SupermemorySource(scope, docs);
    },
  };
}

export const supermemoryFsConnector = connectorFor('fs');
export const supermemoryBlcsConnector = connectorFor('blcs');
export const supermemoryUsaConnector = connectorFor('usa');
export const supermemorySharedConnector = connectorFor('shared');

/** All Supermemory connectors, one per entity container. */
export const supermemoryConnectors: ConnectorSpec[] = SCOPES.map(connectorFor);
