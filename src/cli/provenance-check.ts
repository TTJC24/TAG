#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  validateIngestionEvent,
  type IngestionEvent,
  type IngestionSource,
} from 'gbrain/ingestion';
import { connectors } from '../sources/registry.ts';
import type { ConnectorSpec } from '../sources/types.ts';

interface ProvenanceIssue {
  connector: string;
  event?: string;
  path: string;
  message: string;
}

interface ProvenanceCheckResult {
  ok: boolean;
  issues: ProvenanceIssue[];
  summary: { connectorsChecked: number; eventsChecked: number };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function addIssue(
  issues: ProvenanceIssue[],
  connector: string,
  event: IngestionEvent | undefined,
  path: string,
  message: string,
): void {
  issues.push({ connector, event: event?.source_uri, path, message });
}

function validateUriShape(uri: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(uri);
}

function validateEvent(spec: ConnectorSpec, event: IngestionEvent, issues: ProvenanceIssue[]): void {
  if (event.source_id !== spec.id) {
    addIssue(issues, spec.id, event, 'source_id', `expected ${spec.id}, got ${event.source_id}`);
  }
  if (event.source_kind !== spec.kind) {
    addIssue(issues, spec.id, event, 'source_kind', `expected ${spec.kind}, got ${event.source_kind}`);
  }
  if (!isNonEmptyString(event.source_uri)) {
    addIssue(issues, spec.id, event, 'source_uri', 'missing source_uri');
  } else if (!validateUriShape(event.source_uri)) {
    addIssue(issues, spec.id, event, 'source_uri', 'source_uri must be a stable protocol URI');
  }
  if (!isNonEmptyString(event.content_hash)) {
    addIssue(issues, spec.id, event, 'content_hash', 'missing content_hash');
  }
  if (!isNonEmptyString(event.content)) {
    addIssue(issues, spec.id, event, 'content', 'missing content');
  }
  if (event.content_type !== 'text/markdown') {
    addIssue(issues, spec.id, event, 'content_type', `expected text/markdown, got ${event.content_type}`);
  }
  if (!isNonEmptyString(event.received_at) || Number.isNaN(Date.parse(event.received_at))) {
    addIssue(issues, spec.id, event, 'received_at', 'received_at must be an ISO-like timestamp');
  }
  if (event.untrusted_payload !== false) {
    addIssue(issues, spec.id, event, 'untrusted_payload', 'fixtures should emit trusted, normalized markdown payloads');
  }
  if (!isObject(event.metadata)) {
    addIssue(issues, spec.id, event, 'metadata', 'metadata must be an object');
    return;
  }
  if (!isNonEmptyString(event.metadata.slug)) {
    addIssue(issues, spec.id, event, 'metadata.slug', 'metadata.slug is required for stable imports');
  }
  if (!Object.prototype.hasOwnProperty.call(event.metadata, 'upstream_updated_at')) {
    addIssue(issues, spec.id, event, 'metadata.upstream_updated_at', 'metadata must explicitly include upstream_updated_at or null');
  } else {
    const upstream = event.metadata.upstream_updated_at;
    if (upstream !== null && upstream !== undefined && !isNonEmptyString(upstream)) {
      addIssue(issues, spec.id, event, 'metadata.upstream_updated_at', 'must be string timestamp or null');
    }
  }
  if (!event.content.includes(event.source_uri)) {
    addIssue(issues, spec.id, event, 'content', 'content must include source_uri for operator-visible provenance');
  }
}

async function collectEvents(spec: ConnectorSpec, issues: ProvenanceIssue[]): Promise<IngestionEvent[]> {
  const source = await spec.build({ dryRun: true }) as IngestionSource;
  const events: IngestionEvent[] = [];
  const abortController = new AbortController();
  const stubEngine = new Proxy({}, {
    get() {
      throw new Error('engine access during provenance check is not supported');
    },
  });

  try {
    await source.start({
      emit(event) {
        const err = validateIngestionEvent(event);
        if (err) {
          addIssue(issues, spec.id, event, '$', err.message);
          return;
        }
        events.push(event);
      },
      engine: stubEngine as never,
      logger: console,
      abortSignal: abortController.signal,
      config: { runner: 'company-brain-provenance-check' },
    });
  } finally {
    await source.stop?.();
  }
  return events;
}

export async function runProvenanceCheck(): Promise<ProvenanceCheckResult> {
  const issues: ProvenanceIssue[] = [];
  let connectorsChecked = 0;
  let eventsChecked = 0;
  const seenUris = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const spec of Object.values(connectors)) {
    connectorsChecked += 1;
    let events: IngestionEvent[];
    try {
      events = await collectEvents(spec, issues);
    } catch (err) {
      addIssue(issues, spec.id, undefined, '$', `connector dry-run failed: ${(err as Error).message}`);
      continue;
    }
    if (events.length === 0) {
      addIssue(issues, spec.id, undefined, '$', 'connector emitted no fixture events');
    }
    for (const event of events) {
      eventsChecked += 1;
      validateEvent(spec, event, issues);
      if (seenUris.has(event.source_uri)) {
        addIssue(issues, spec.id, event, 'source_uri', 'duplicate source_uri emitted across fixture dry-run');
      }
      seenUris.add(event.source_uri);
      const slug = isObject(event.metadata) && isNonEmptyString(event.metadata.slug) ? event.metadata.slug : undefined;
      if (slug) {
        if (seenSlugs.has(slug)) {
          addIssue(issues, spec.id, event, 'metadata.slug', 'duplicate slug emitted across fixture dry-run');
        }
        seenSlugs.add(slug);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: { connectorsChecked, eventsChecked },
  };
}

function formatReport(result: ProvenanceCheckResult): string {
  if (result.ok) {
    return `provenance:check OK - ${result.summary.connectorsChecked} connectors, ${result.summary.eventsChecked} events, 0 issues`;
  }
  const lines = [
    `provenance:check FAILED - ${result.summary.connectorsChecked} connectors, ${result.summary.eventsChecked} events, ${result.issues.length} issue(s):`,
  ];
  for (const issue of result.issues) {
    const event = issue.event ? ` ${issue.event}` : '';
    lines.push(`  [${issue.connector}]${event} ${issue.path}: ${issue.message}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const result = await runProvenanceCheck();
  const report = formatReport(result);
  if (result.ok) {
    console.log(report);
    process.exit(0);
  }
  console.error(report);
  process.exit(1);
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
    return norm(process.argv[1]) === norm(here);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
