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

export type AcumaticaEntityKind = 'customer' | 'order' | 'invoice' | 'item';

export interface AcumaticaEntity {
  kind: AcumaticaEntityKind;
  id: string;
  name: string;
  updated_at: string;
  body: Record<string, unknown>;
}

export interface AcumaticaSnapshot {
  customers: AcumaticaEntity[];
  orders: AcumaticaEntity[];
  invoices: AcumaticaEntity[];
  items: AcumaticaEntity[];
}

function slugFor(e: AcumaticaEntity): string {
  const short = computeContentHash(`${e.kind}/${e.id}`).slice(0, 10);
  return `acumatica/${e.kind}/${e.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${short}`;
}

function sourceUri(e: AcumaticaEntity): string {
  return `acumatica://${e.kind}/${encodeURIComponent(e.id)}`;
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

function markdownFor(e: AcumaticaEntity): string {
  return `---
type: note
title: "${e.name.replaceAll('"', '\\"')}"
acumatica_id: "${e.id.replaceAll('"', '\\"')}"
acumatica_kind: "${e.kind}"
source_uri: "${sourceUri(e)}"
source_kind: "${SOURCE_KIND}"
updated_at: "${e.updated_at}"
---

# ${e.name}

- Source: ${sourceUri(e)}
- Kind: ${e.kind}
- Updated: ${e.updated_at}

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
      ...this.snapshot.orders,
      ...this.snapshot.invoices,
      ...this.snapshot.items,
    ];
    for (const e of all) {
      const content = markdownFor(e);
      ctx.emit({
        source_id: this.id,
        source_kind: this.kind,
        source_uri: sourceUri(e),
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content,
        content_hash: computeContentHash(content),
        untrusted_payload: false,
        metadata: {
          slug: slugFor(e),
          entity_kind: e.kind,
          entity_id: e.id,
          updated_at: e.updated_at,
        },
      });
    }
  }

  async stop(): Promise<void> {}
}

async function loadSnapshot(dryRun: boolean, entity?: EntityCode): Promise<AcumaticaSnapshot> {
  if (dryRun) {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as AcumaticaSnapshot;
  }
  return await fetchAcumaticaSnapshot(entity);
}

export function createAcumaticaConnector(id = SOURCE_ID, displayName = 'Acumatica ERP', entity?: EntityCode): ConnectorSpec {
  const requiredEnv = ['ACUMATICA_BASE_URL', 'ACUMATICA_USERNAME', 'ACUMATICA_PASSWORD'];
  requiredEnv.push(...(entity ? [`ACUMATICA_TENANT_${entity}`, `ACUMATICA_BRANCH_${entity}`] : ['ACUMATICA_TENANT', 'ACUMATICA_BRANCH']));
  return {
    id,
    displayName,
    kind: SOURCE_KIND,
    fixturePath: FIXTURE_PATH,
    requiredEnv,
    async build({ dryRun }) {
      const snapshot = await loadSnapshot(dryRun, entity);
      return new AcumaticaSource(id, snapshot);
    },
  };
}

export const acumaticaConnector: ConnectorSpec = createAcumaticaConnector();
