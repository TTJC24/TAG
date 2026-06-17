#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const required: Record<string, string[]> = {
  'docs/live-readiness-ledger.md': [
    'live readiness status: blocked',
    'safe configured environment: missing',
    '`bun run smoke`: local fixture-mode smoke passes',
    '`bun run smoke:api`: local fixture-mode API smoke passes',
    'live source freshness check: missing',
    'bounded live-read proof: missing',
    'production API token/deployment proof: missing',
    'downstream consumer smoke: missing',
    'This is not the same as proving live source freshness or production API readiness.',
    'Required Evidence Before Live Promotion',
    'sanitized failure states',
    'Blocked:',
    'Do not promote live Company Brain',
  ],
  'docs/source-lifecycle-and-provenance.md': [
    'Current gap: live source freshness against configured systems and production environment verification still need a safe configured environment.',
    'Local fixture-mode `smoke` and `smoke:api` now prove seeded fixture/domain/API behavior',
    'live configured source checks still need safe env verification',
    'source failures produce sanitized operator-facing states',
    'live readiness checks perform bounded reads only',
  ],
  'docs/product-boundary.md': [
    'Before production-impacting changes, still run the deeper checks in an environment with the required local services and safe credentials:',
    'bun run smoke',
    'bun run smoke:api',
    'workflow provides Postgres 16 and fixture-mode placeholder env vars',
  ],
  'package.json': [
    '"live-readiness:check"',
  ],
};

const blockedClaims = [
  'live production-ready',
  'fully configured live company brain',
  'public or customer-facing knowledge api',
  'downstream product dependency on live company brain data',
];

const allowedNegativeMarkers = [
  'blocked',
  'do not',
  'not recorded',
  'not the same',
  'until',
  'unverified',
  'missing',
];

const claimFiles = [
  'README.md',
  'COMPANY_BRAIN.md',
  'docs/product-boundary.md',
  'docs/source-lifecycle-and-provenance.md',
  'docs/live-readiness-ledger.md',
];

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function main(): void {
  const issues: string[] = [];

  for (const [relativePath, phrases] of Object.entries(required)) {
    let text = '';
    try {
      text = read(relativePath).toLowerCase();
    } catch {
      issues.push(`missing live-readiness file: ${relativePath}`);
      continue;
    }

    for (const phrase of phrases) {
      if (!text.includes(phrase.toLowerCase())) {
        issues.push(`${relativePath}: missing required phrase \`${phrase}\``);
      }
    }
  }

  for (const relativePath of claimFiles) {
    let lines: string[] = [];
    try {
      lines = read(relativePath).split(/\r?\n/);
    } catch {
      continue;
    }

    lines.forEach((line, index) => {
      const normalized = line.toLowerCase();
      for (const claim of blockedClaims) {
        if (!normalized.includes(claim)) continue;
        if (allowedNegativeMarkers.some((marker) => normalized.includes(marker))) continue;
        issues.push(`${relativePath}:${index + 1}: unqualified blocked live-readiness claim \`${claim}\``);
      }
    });
  }

  if (issues.length > 0) {
    console.error('Company Brain live readiness check failed:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  console.log('Company Brain live readiness check passed.');
}

main();
