#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { askBrain } from '../ask.ts';
import { ensureSourceRow, openEngine } from '../engine.ts';
import { hybridSearch } from '../gbrainCompat.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function resetStore(): void {
  if (existsSync('.company-brain-store.json')) unlinkSync('.company-brain-store.json');
}

async function seedPage(
  sourceId: string,
  slug: string,
  content: string,
  sourceUri?: string,
): Promise<void> {
  const engine = await openEngine();
  try {
    await ensureSourceRow(engine, sourceId, sourceId);
    const importer = engine as typeof engine & {
      importContent: (
        slug: string,
        content: string,
        options: Record<string, unknown>,
      ) => Promise<{ status: 'imported' | 'skipped'; slug: string }>;
    };
    await importer.importContent(slug, content, {
      source_id: sourceId,
      sourceId,
      source_uri: sourceUri,
      source_kind: sourceId,
    });
  } finally {
    await engine.disconnect();
  }
}

async function assertSourceFiltering(): Promise<void> {
  resetStore();
  await seedPage(
    'acumatica',
    'acumatica/customer/acme',
    [
      '# ACME Barricades LC',
      'CustomerName: ACME Barricades LC',
      'Terms: N30',
      'Status: Active',
    ].join('\n'),
    'acumatica://customer/acme',
  );
  await seedPage(
    'm365-mail',
    'm365/mail/acme-note',
    [
      '# ACME mailbox note',
      'From: ap@acmebarricades.example.com',
      'Received: 2026-05-30T09:00:00Z',
      'Subject: ACME invoice copy',
    ].join('\n'),
    'm365-mail://message/acme-note',
  );

  const engine = await openEngine();
  try {
    const mailHits = await hybridSearch(engine, 'acme', { sourceIds: ['m365-mail'], limit: 10 });
    assert(mailHits.length > 0, 'expected a mail hit in the mail-scoped search');
    assert(
      mailHits.every((hit) => hit.source_id === 'm365-mail'),
      `mail-scoped search leaked other sources: ${mailHits.map((hit) => hit.source_id).join(', ')}`,
    );

    const revenueHits = await hybridSearch(engine, 'acme', { sourceIds: ['acumatica'], limit: 10 });
    assert(revenueHits.length > 0, 'expected a revenue hit in the Acumatica-scoped search');
    assert(
      revenueHits.every((hit) => hit.source_id === 'acumatica'),
      `Acumatica-scoped search leaked other sources: ${revenueHits.map((hit) => hit.source_id).join(', ')}`,
    );
  } finally {
    await engine.disconnect();
  }
}

async function assertMissingProvenanceRefusal(): Promise<void> {
  resetStore();
  await seedPage(
    'acumatica',
    'acumatica/customer/acme',
    [
      '# ACME Barricades LC',
      'CustomerName: ACME Barricades LC',
      'Terms: N30',
      'Status: Active',
    ].join('\n'),
  );

  const answer = await askBrain({ question: 'terms for acme', sources: ['acumatica'], limit: 5 });
  assert(answer.confidence === 'low', `missing-provenance answer should be low confidence, got ${answer.confidence}`);
  assert(answer.citations.length === 0, 'missing-provenance answer should not return authoritative citations');
  assert(
    /missing stable source provenance/i.test(answer.text),
    `missing-provenance answer did not explain the issue:\n${answer.text}`,
  );
  assert(!/\bTerms:\s*N30\b/i.test(answer.text), 'missing-provenance answer rendered authoritative field data');
}

async function assertAvailableSourceLaneDoesNotBorrowOtherSources(): Promise<void> {
  resetStore();
  await seedPage(
    'acumatica',
    'acumatica/customer/globotech',
    [
      '# Globotech LLC',
      'CustomerName: Globotech LLC',
      'Terms: N45',
      'Status: Active',
    ].join('\n'),
    'acumatica://customer/globotech',
  );

  const answer = await askBrain({ question: 'emails about globotech', sources: ['m365-mail'], limit: 5 });
  assert(answer.intent === 'collaboration_lookup', `expected collaboration lookup, got ${answer.intent}`);
  assert(answer.confidence === 'low', `expected low confidence when the requested source lane is empty, got ${answer.confidence}`);
  assert(answer.citations.length === 0, 'empty mail lane should not cite revenue records');
  assert(!/Globotech LLC:|Terms:\s*N45/i.test(answer.text), `empty mail lane borrowed revenue data:\n${answer.text}`);
}

async function main(): Promise<void> {
  await assertSourceFiltering();
  await assertMissingProvenanceRefusal();
  await assertAvailableSourceLaneDoesNotBorrowOtherSources();
  resetStore();

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'source-scoped search does not bleed across connectors',
      'matching records without stable source_uri are refused as non-authoritative',
      'empty requested source lanes do not borrow evidence from other source lanes',
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
