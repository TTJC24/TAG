import { readFileSync } from 'node:fs';
import {
  computeContentHash,
  type IngestionSource,
  type IngestionSourceContext,
} from 'gbrain/ingestion';
import type { EntityCode } from '../config.ts';
import type { ConnectorSpec } from './types.ts';
import { fetchAcumaticaSnapshot } from './acumatica/client.ts';

const SOURCE_ID = 'acumatica';
const SOURCE_KIND = 'acumatica';
const FIXTURE_PATH = 'fixtures/acumatica/snapshot.json';

export type AcumaticaEntityKind = 'customer' | 'item' | 'vendor' | 'order' | 'invoice' | 'rep';

export interface AcumaticaEntity {
  kind: AcumaticaEntityKind;
  id: string;
  name: string;
  updated_at: string;
  body: Record<string, unknown>;
}

export interface AcumaticaSnapshot {
  customers: AcumaticaEntity[];
  items: AcumaticaEntity[];
  vendors: AcumaticaEntity[];
  orders: AcumaticaEntity[];
  invoices: AcumaticaEntity[];
  reps: AcumaticaEntity[];
}

function slugFor(sourceId: string, e: AcumaticaEntity): string {
  const short = computeContentHash(`${sourceId}/${e.kind}/${e.id}`).slice(0, 10);
  return `${sourceId}/${e.kind}/${e.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${short}`;
}

function sourceUri(sourceId: string, e: AcumaticaEntity): string {
  return `acumatica://${sourceId}/${e.kind}/${encodeURIComponent(e.id)}`;
}

function renderBody(body: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      lines.push(`- **${k}**: ${JSON.stringify(v)}`);
    } else {
      lines.push(`- **${k}**: ${String(v)}`);
    }
  }
  return lines.join('\n');
}

function markdownFor(sourceId: string, e: AcumaticaEntity): string {
  return `---
type: note
title: "${e.name.replaceAll('"', '\\"')}"
acumatica_id: "${e.id.replaceAll('"', '\\"')}"
acumatica_kind: "${e.kind}"
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
`;
}

class AcumaticaSource implements IngestionSource {
  readonly kind = SOURCE_KIND;
  readonly mode = 'migration' as const;

  constructor(readonly id: string, private readonly snapshot: AcumaticaSnapshot) {}

  async start(ctx: IngestionSourceContext): Promise<void> {
    const all = [
      ...this.snapshot.customers,
      ...this.snapshot.items,
      ...this.snapshot.vendors,
      ...this.snapshot.orders,
      ...this.snapshot.invoices,
      ...this.snapshot.reps,
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
          // v3 freshness contract: explicit upstream timestamp, null when the
          // source row did not carry LastModifiedDateTime. Consumers should
          // prefer this over `updated_at` (which is "" when unknown for
          // backward-compat) and over received_at (which is wall-clock).
          upstream_updated_at: e.updated_at || null,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadSnapshot(dryRun: boolean, entity?: EntityCode, cap?: number): Promise<AcumaticaSnapshot> {
  if (dryRun) {
    return normalizeSnapshot(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Partial<AcumaticaSnapshot>);
  }
  return await fetchAcumaticaSnapshot({ entity, cap });
}

function normalizeSnapshot(snapshot: Partial<AcumaticaSnapshot>): AcumaticaSnapshot {
  return {
    customers: snapshot.customers ?? [],
    items: snapshot.items ?? [],
    vendors: snapshot.vendors ?? [],
    orders: snapshot.orders ?? [],
    invoices: snapshot.invoices ?? [],
    reps: snapshot.reps ?? [],
  };
}

export function createAcumaticaConnector(id = SOURCE_ID, displayName = 'Acumatica ERP', entity?: EntityCode): ConnectorSpec {
  const requiredEnv = ['ACUMATICA_BASE_URL', 'ACUMATICA_USERNAME', 'ACUMATICA_PASSWORD', 'ACUMATICA_TENANT'];
  if (entity) requiredEnv.push(`ACUMATICA_BRANCH_${entity}`);
  return {
    id,
    displayName,
    kind: SOURCE_KIND,
    fixturePath: FIXTURE_PATH,
    requiredEnv,
    async build({ dryRun, cap }) {
      const snapshot = await loadSnapshot(dryRun, entity, cap);
      return new AcumaticaSource(id, snapshot);
    },
  };
}

export const acumaticaConnector: ConnectorSpec = createAcumaticaConnector();
