#!/usr/bin/env bun
import { Pool } from 'pg';
import { config } from '../config.ts';
import { openEngine } from '../engine.ts';

interface SeedPage {
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  slug: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

const now = '2026-06-20T00:00:00Z';

const pages: SeedPage[] = [
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/customer/ACME001',
    title: 'ACME Supply',
    body: [
      '# ACME Supply',
      '- **CustomerID**: ACME001',
      '- **CustomerName**: ACME Supply',
      '- **Status**: Active',
      '- **Terms**: Net 30',
      '- **SourceURI**: acumatica://customer/ACME001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://customer/ACME001',
      acumatica_kind: 'customer',
      acumatica_id: 'ACME001',
      updated_at: now,
    },
  },
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/order/SO1001',
    title: 'SO1001 - ACME Supply',
    body: [
      '# SO1001 - ACME Supply',
      '- **OrderNbr**: SO1001',
      '- **CustomerID**: ACME001',
      '- **Status**: Open',
      '- **Amount**: 1250.00',
      '- **SourceURI**: acumatica://order/SO1001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://order/SO1001',
      acumatica_kind: 'order',
      acumatica_id: 'SO1001',
      updated_at: now,
    },
  },
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/invoice/INV1001',
    title: 'INV1001 - ACME Supply',
    body: [
      '# INV1001 - ACME Supply',
      '- **ReferenceNbr**: INV1001',
      '- **CustomerID**: ACME001',
      '- **Status**: Open',
      '- **Balance**: 1250.00',
      '- **SourceURI**: acumatica://invoice/INV1001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://invoice/INV1001',
      acumatica_kind: 'invoice',
      acumatica_id: 'INV1001',
      updated_at: now,
    },
  },
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/item/00286',
    title: '00286 Wedge Anchor',
    body: [
      '# 00286 Wedge Anchor',
      '- **InventoryID**: 00286',
      '- **Description**: Wedge Anchor',
      '- **Status**: Active',
      '- **SourceURI**: acumatica://item/00286',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://item/00286',
      acumatica_kind: 'item',
      acumatica_id: '00286',
      updated_at: now,
    },
  },
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/vendor/VEND001',
    title: 'Anchor Vendor',
    body: [
      '# Anchor Vendor',
      '- **VendorID**: VEND001',
      '- **VendorName**: Anchor Vendor',
      '- **Status**: Active',
      '- **SourceURI**: acumatica://vendor/VEND001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://vendor/VEND001',
      acumatica_kind: 'vendor',
      acumatica_id: 'VEND001',
      updated_at: now,
    },
  },
  {
    sourceId: 'acumatica-fs',
    sourceName: 'Acumatica FS',
    sourceKind: 'acumatica',
    slug: 'static-fixture/acumatica-fs/rep/REP001',
    title: 'Taylor Clark',
    body: [
      '# Taylor Clark',
      '- **SalespersonID**: REP001',
      '- **Name**: Taylor Clark',
      '- **Status**: Active',
      '- **SourceURI**: acumatica://rep/REP001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'acumatica',
      source_uri: 'acumatica://rep/REP001',
      acumatica_kind: 'rep',
      acumatica_id: 'REP001',
      updated_at: now,
    },
  },
  {
    sourceId: 'pipedrive-fs',
    sourceName: 'Pipedrive FS',
    sourceKind: 'pipedrive',
    slug: 'static-fixture/pipedrive-fs/deal/12001',
    title: 'ACME reorder opportunity',
    body: [
      '# ACME reorder opportunity',
      '- **title**: ACME reorder opportunity',
      '- **org_id**: {"value":3011,"name":"ACME Supply"}',
      '- **person_id**: {"value":2031,"name":"Jane Buyer"}',
      '- **status**: open',
      '- **value**: 1250',
      '- **SourceURI**: pipedrive://deal/12001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'pipedrive',
      source_uri: 'pipedrive://deal/12001',
      pipedrive_kind: 'deal',
      pipedrive_id: '12001',
      updated_at: now,
    },
  },
  {
    sourceId: 'pipedrive-fs',
    sourceName: 'Pipedrive FS',
    sourceKind: 'pipedrive',
    slug: 'static-fixture/pipedrive-fs/person/2031',
    title: 'Jane Buyer',
    body: [
      '# Jane Buyer',
      '- **name**: Jane Buyer',
      '- **org_id**: {"value":3011,"name":"ACME Supply"}',
      '- **email**: jane@example.test',
      '- **phone**: 555-0100',
      '- **SourceURI**: pipedrive://person/2031',
    ].join('\n'),
    frontmatter: {
      source_kind: 'pipedrive',
      source_uri: 'pipedrive://person/2031',
      pipedrive_kind: 'person',
      pipedrive_id: '2031',
      updated_at: now,
    },
  },
  {
    sourceId: 'pipedrive-fs',
    sourceName: 'Pipedrive FS',
    sourceKind: 'pipedrive',
    slug: 'static-fixture/pipedrive-fs/activity/7001',
    title: 'Call Jane Buyer',
    body: [
      '# Call Jane Buyer',
      '- **subject**: Call Jane Buyer',
      '- **type**: call',
      '- **org_id**: {"value":3011,"name":"ACME Supply"}',
      '- **person_id**: {"value":2031,"name":"Jane Buyer"}',
      '- **deal_id**: {"value":12001,"title":"ACME reorder opportunity"}',
      '- **SourceURI**: pipedrive://activity/7001',
    ].join('\n'),
    frontmatter: {
      source_kind: 'pipedrive',
      source_uri: 'pipedrive://activity/7001',
      pipedrive_kind: 'activity',
      pipedrive_id: '7001',
      updated_at: now,
    },
  },
];

function requirePostgres(): void {
  if (config.COMPANY_BRAIN_ENGINE !== 'postgres') {
    throw new Error('static fixture seed requires COMPANY_BRAIN_ENGINE=postgres');
  }
}

async function main(): Promise<void> {
  requirePostgres();

  const engine = await openEngine();
  await engine.disconnect();

  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceIds = [...new Set(pages.map((page) => page.sourceId))];
    await client.query('DELETE FROM pages WHERE source_id = ANY($1::text[])', [sourceIds]);
    await client.query('DELETE FROM sources WHERE id = ANY($1::text[])', [sourceIds]);

    for (const sourceId of sourceIds) {
      const page = pages.find((candidate) => candidate.sourceId === sourceId);
      if (!page) continue;
      await client.query(
        `INSERT INTO sources (id, name, local_path, config, archived, created_at)
         VALUES ($1, $2, NULL, '{}'::jsonb, false, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [sourceId, page.sourceName],
      );
    }

    for (const page of pages) {
      await client.query(
        `INSERT INTO pages (
          source_id, slug, type, page_kind, title, compiled_truth, timeline,
          frontmatter, content_hash, effective_date, import_filename,
          source_uri, source_kind, ingested_via, ingested_at, updated_at
        ) VALUES (
          $1, $2, 'note', 'markdown', $3, $4, '',
          $5::jsonb, $6, $7::timestamptz, $2,
          $8, $9, 'static-fixture-seed', now(), $7::timestamptz
        )`,
        [
          page.sourceId,
          page.slug,
          page.title,
          page.body,
          JSON.stringify(page.frontmatter),
          `static-fixture-${page.slug}`,
          now,
          page.frontmatter.source_uri,
          page.sourceKind,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify({ ok: true, inserted: pages.length }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
