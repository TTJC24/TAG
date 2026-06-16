#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { askBrain, type BrainAnswer, type BrainCitation } from '../ask.ts';
import { hybridSearch } from '../gbrainCompat.ts';
import { runIngestion } from '../ingest/run.ts';
import { connectors } from '../sources/registry.ts';
import { openEngine } from '../engine.ts';
import { runFixtureCheck } from './fixture-check.ts';

type CitationExpectation = {
  name: string;
  question: string;
  assert: (answer: BrainAnswer) => void;
};

type EvalResult = { name: string; ok: true; citations: number };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertText(answer: BrainAnswer, pattern: RegExp, message: string): void {
  assert(pattern.test(answer.text), `${message}\nAnswer:\n${answer.text}`);
}

function isProtocolUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function assertCitationMetadata(citation: BrainCitation, context: string): void {
  assert(citation.slug.trim().length > 0, `${context}: citation slug is required`);
  assert(citation.source_id.trim().length > 0, `${context}: citation source_id is required`);
  assert(citation.source_uri !== null, `${context}: citation source pointer is required`);
  if (citation.source_uri !== null) {
    assert(citation.source_uri.trim().length > 0, `${context}: citation source pointer cannot be blank`);
    assert(
      isProtocolUri(citation.source_uri),
      `${context}: citation source_uri must be protocol-shaped, got ${citation.source_uri}`,
    );
  }
}

function assertCitedAnswer(answer: BrainAnswer, expectedSources: readonly string[], context: string): void {
  assert(answer.citations.length > 0, `${context}: answer returned no citations`);
  for (const citation of answer.citations) {
    assertCitationMetadata(citation, context);
    assert(
      expectedSources.includes(citation.source_id),
      `${context}: unexpected citation source ${citation.source_id}; expected one of ${expectedSources.join(', ')}`,
    );
  }
}

async function ensureFixtureBrain(): Promise<void> {
  if (existsSync('.company-brain-store.json')) {
    unlinkSync('.company-brain-store.json');
  }

  const engine = await openEngine();
  try {
    const stats = await engine.getStats() as { page_count?: number };
    if (Number(stats.page_count ?? 0) > 0) return;
  } finally {
    await engine.disconnect();
  }

  for (const spec of Object.values(connectors)) {
    const source = await spec.build({ dryRun: true });
    await runIngestion(spec.id, spec.displayName, source, {
      dryRun: false,
      noEmbed: true,
      ingestedVia: 'citation-eval-fixtures',
      summaryOnly: true,
      quiet: true,
    });
  }
}

async function assertSearchResultsExposeSourceUris(): Promise<void> {
  const engine = await openEngine();
  try {
    const hits = await hybridSearch(engine, 'acme terms', { sourceIds: ['acumatica'], limit: 5 });
    assert(hits.length > 0, 'search provenance check returned no Acumatica hits');
    for (const hit of hits) {
      const sourceUri = (hit as { source_uri?: unknown }).source_uri;
      assert(typeof sourceUri === 'string' && sourceUri.length > 0, `search hit ${hit.slug} is missing source_uri`);
      assert(isProtocolUri(sourceUri), `search hit ${hit.slug} source_uri must be protocol-shaped, got ${sourceUri}`);
    }
  } finally {
    await engine.disconnect();
  }
}

const citationCases: CitationExpectation[] = [
  {
    name: 'customer terms citations expose source metadata',
    question: 'terms for acme',
    assert(answer) {
      assert(answer.intent === 'customer_lookup', `expected customer_lookup, got ${answer.intent}`);
      assertCitedAnswer(answer, ['acumatica', 'pipedrive'], 'customer terms');
      assertText(answer, /\bTerms:\s*N30\b/i, 'customer terms answer did not include requested field');
    },
  },
  {
    name: 'exact item citation exposes source metadata',
    question: 'price for 00286',
    assert(answer) {
      assert(answer.intent === 'item_lookup', `expected item_lookup, got ${answer.intent}`);
      assertCitedAnswer(answer, ['acumatica'], 'item price');
      assert(
        answer.citations.every((citation) => /\/item\//i.test(citation.slug)),
        'item price should cite Acumatica item evidence',
      );
      assertText(answer, /Inventory ID:\s*00286/i, 'item price answer did not include requested SKU');
    },
  },
  {
    name: 'latest email cites mail and renders freshness cue',
    question: 'latest email',
    assert(answer) {
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assertCitedAnswer(answer, ['m365-mail'], 'latest email');
      assertText(answer, /\bReceived:\s*\d{4}-\d{2}-\d{2}T/i, 'latest email answer did not render received timestamp');
    },
  },
  {
    name: 'latest meeting cites calendar and renders start timestamp',
    question: 'latest meeting',
    assert(answer) {
      assert(answer.intent === 'collaboration_lookup', `expected collaboration_lookup, got ${answer.intent}`);
      assertCitedAnswer(answer, ['m365-calendar'], 'latest meeting');
      assertText(answer, /\bStart:\s*\d{4}-\d{2}-\d{2}T/i, 'latest meeting answer did not render start timestamp');
    },
  },
  {
    name: 'ambiguous customer shorthand has no authoritative citations',
    question: 'terms for hardware',
    assert(answer) {
      assert(answer.confidence === 'low', `expected low confidence, got ${answer.confidence}`);
      assert(answer.resolvedEntity?.ambiguous === true, 'ambiguous ask was not marked ambiguous');
      assert(answer.citations.length === 0, 'ambiguous shorthand should not return authoritative citations');
    },
  },
];

async function main(): Promise<void> {
  const fixtureCheck = runFixtureCheck();
  if (!fixtureCheck.ok) {
    console.error(JSON.stringify({
      ok: false,
      preflight: {
        'fixtures:check': {
          ok: false,
          fixturesChecked: fixtureCheck.summary.fixturesChecked,
          itemsChecked: fixtureCheck.summary.itemsChecked,
          issues: fixtureCheck.issues,
        },
      },
    }, null, 2));
    process.exit(1);
  }

  await ensureFixtureBrain();
  await assertSearchResultsExposeSourceUris();
  const cases: EvalResult[] = [];
  for (const testCase of citationCases) {
    const answer = await askBrain({ question: testCase.question, limit: 8 });
    testCase.assert(answer);
    cases.push({ name: testCase.name, ok: true, citations: answer.citations.length });
  }

  console.log(JSON.stringify({
    ok: true,
    preflight: {
      'fixtures:check': {
        ok: true,
        fixturesChecked: fixtureCheck.summary.fixturesChecked,
        itemsChecked: fixtureCheck.summary.itemsChecked,
      },
      'search-source-uri': { ok: true },
    },
    summary: { passed: cases.length, total: cases.length },
    cases,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
