#!/usr/bin/env node
/**
 * Deterministic fixture validator.
 *
 * Reads every JSON fixture under fixtures/, checks that:
 *   1. The JSON is well-formed.
 *   2. Each item has the required fields for its connector type.
 *   3. No duplicate `id` values within an entity-type array.
 *   4. Cross-references between entities resolve:
 *        - acumatica: orders/invoices body.CustomerID → customers[].id
 *        - m365-teams: reply_to_id (when non-null) → another thread's id
 *
 * Runnable as a CLI (`tsx src/cli/fixture-check.ts` → exits 0/1) or by
 * importing `runFixtureCheck()` from another module (e.g. the eval suite's
 * preflight gate). The CLI entrypoint is guarded so importing this file does
 * NOT trigger a side-effecting validation run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FixtureIssue {
  fixture: string;
  path: string;
  message: string;
}

export interface FixtureCheckResult {
  ok: boolean;
  issues: FixtureIssue[];
  summary: { fixturesChecked: number; itemsChecked: number };
}

const FIXTURE_FILES: Record<string, string> = {
  acumatica: 'fixtures/acumatica/snapshot.json',
  'm365-calendar': 'fixtures/m365-calendar/events.json',
  'm365-mail': 'fixtures/m365-mail/messages.json',
  'm365-sharepoint': 'fixtures/m365-sharepoint/items.json',
  'm365-teams': 'fixtures/m365-teams/threads.json',
  pipedrive: 'fixtures/pipedrive/snapshot.json',
  'supermemory-fs': 'fixtures/supermemory/fs.json',
};

function parseJson(path: string, fixture: string, issues: FixtureIssue[]): unknown | undefined {
  if (!existsSync(path)) {
    issues.push({ fixture, path, message: 'fixture file not found' });
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    issues.push({ fixture, path, message: `read failed: ${(err as Error).message}` });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    issues.push({ fixture, path, message: `invalid JSON: ${(err as Error).message}` });
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function requireFields(
  item: unknown,
  required: readonly string[],
  fixture: string,
  itemPath: string,
  issues: FixtureIssue[],
): void {
  if (!isObject(item)) {
    issues.push({ fixture, path: itemPath, message: 'expected object' });
    return;
  }
  for (const field of required) {
    const v = item[field];
    if (v === undefined || v === null || (typeof v === 'string' && v.length === 0)) {
      issues.push({ fixture, path: `${itemPath}.${field}`, message: 'required field missing or empty' });
    }
  }
}

function checkDuplicateIds(
  items: readonly unknown[],
  idField: string,
  fixture: string,
  groupName: string,
  issues: FixtureIssue[],
): void {
  const seen = new Map<string, number>();
  items.forEach((item, idx) => {
    if (!isObject(item)) return;
    const raw = item[idField];
    if (typeof raw !== 'string' && typeof raw !== 'number') return;
    const key = String(raw);
    const prior = seen.get(key);
    if (prior !== undefined) {
      issues.push({
        fixture,
        path: `${groupName}[${idx}].${idField}`,
        message: `duplicate id "${key}" (also at ${groupName}[${prior}])`,
      });
    } else {
      seen.set(key, idx);
    }
  });
}

/**
 * Validate an array-shaped fixture: every item has `idField` + `required`
 * fields, ids are unique. Optional `extraCheck` runs additional invariants
 * (e.g. cross-refs within the array).
 */
function checkArrayFixture(
  data: unknown,
  fixture: string,
  required: readonly string[],
  idField: string,
  counter: { items: number },
  issues: FixtureIssue[],
  extraCheck?: (items: readonly Record<string, unknown>[]) => void,
): void {
  if (!Array.isArray(data)) {
    issues.push({ fixture, path: '$', message: 'expected top-level array' });
    return;
  }
  data.forEach((item, idx) => {
    counter.items += 1;
    requireFields(item, required, fixture, `[${idx}]`, issues);
  });
  checkDuplicateIds(data, idField, fixture, '$', issues);
  if (extraCheck) {
    const objs = data.filter(isObject) as Record<string, unknown>[];
    extraCheck(objs);
  }
}

function checkAcumatica(
  data: unknown,
  fixture: string,
  counter: { items: number },
  issues: FixtureIssue[],
): void {
  if (!isObject(data)) {
    issues.push({ fixture, path: '$', message: 'expected top-level object' });
    return;
  }
  // Each group: array name in fixture, expected `kind` discriminator, and
  // any required keys on the `body` sub-object (per task spec example:
  // customers must carry CustomerID + CustomerName).
  const groups = [
    { name: 'customers', kind: 'customer', bodyRequired: ['CustomerID', 'CustomerName'] as const },
    { name: 'orders', kind: 'order', bodyRequired: ['OrderNbr', 'CustomerID'] as const },
    // Acumatica's invoice contract uses ReferenceNbr (matches AR REST schema),
    // not InvoiceNbr. CustomerID is the FK back into the customers array.
    { name: 'invoices', kind: 'invoice', bodyRequired: ['ReferenceNbr', 'CustomerID'] as const },
    // Item rows are stock-master rows; InventoryID is the natural key the
    // connector dedups on.
    { name: 'items', kind: 'item', bodyRequired: ['InventoryID'] as const },
  ] as const;

  for (const g of groups) {
    const arr = data[g.name];
    if (arr === undefined) {
      issues.push({ fixture, path: g.name, message: `expected array at .${g.name}` });
      continue;
    }
    if (!Array.isArray(arr)) {
      issues.push({ fixture, path: g.name, message: `expected array at .${g.name}, got ${typeof arr}` });
      continue;
    }
    arr.forEach((item, idx) => {
      counter.items += 1;
      const itemPath = `${g.name}[${idx}]`;
      requireFields(item, ['kind', 'id', 'name', 'updated_at', 'body'], fixture, itemPath, issues);
      if (isObject(item) && item.kind !== g.kind) {
        issues.push({
          fixture,
          path: `${itemPath}.kind`,
          message: `expected kind="${g.kind}", got ${JSON.stringify(item.kind)}`,
        });
      }
      if (isObject(item) && isObject(item.body) && g.bodyRequired.length > 0) {
        requireFields(item.body, g.bodyRequired, fixture, `${itemPath}.body`, issues);
      }
    });
    checkDuplicateIds(arr, 'id', fixture, g.name, issues);
  }

  // Cross-reference: orders / invoices body.CustomerID must resolve to a known customer.id
  const customers = Array.isArray(data.customers) ? data.customers : [];
  const customerIds = new Set<string>();
  for (const c of customers) {
    if (isObject(c) && (typeof c.id === 'string' || typeof c.id === 'number')) {
      customerIds.add(String(c.id));
    }
  }
  for (const refGroup of ['orders', 'invoices'] as const) {
    const arr = data[refGroup];
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, idx) => {
      if (!isObject(item)) return;
      const body = isObject(item.body) ? item.body : undefined;
      const ref = body?.CustomerID;
      if (ref === undefined || ref === null) return;
      const refKey = String(ref);
      if (!customerIds.has(refKey)) {
        issues.push({
          fixture,
          path: `${refGroup}[${idx}].body.CustomerID`,
          message: `cross-reference to customer "${refKey}" does not resolve`,
        });
      }
    });
  }
}

function checkPipedrive(
  data: unknown,
  fixture: string,
  counter: { items: number },
  issues: FixtureIssue[],
): void {
  if (!isObject(data)) {
    issues.push({ fixture, path: '$', message: 'expected top-level object' });
    return;
  }
  const groups = [
    { name: 'deals', kind: 'deal' },
    { name: 'persons', kind: 'person' },
    { name: 'organizations', kind: 'organization' },
    { name: 'activities', kind: 'activity' },
    { name: 'notes', kind: 'note' },
  ] as const;

  for (const g of groups) {
    const arr = data[g.name];
    if (arr === undefined) {
      issues.push({ fixture, path: g.name, message: `expected array at .${g.name}` });
      continue;
    }
    if (!Array.isArray(arr)) {
      issues.push({ fixture, path: g.name, message: `expected array at .${g.name}, got ${typeof arr}` });
      continue;
    }
    arr.forEach((item, idx) => {
      counter.items += 1;
      const itemPath = `${g.name}[${idx}]`;
      requireFields(item, ['kind', 'id', 'name', 'updated_at', 'body'], fixture, itemPath, issues);
      if (isObject(item) && item.kind !== g.kind) {
        issues.push({
          fixture,
          path: `${itemPath}.kind`,
          message: `expected kind="${g.kind}", got ${JSON.stringify(item.kind)}`,
        });
      }
    });
    checkDuplicateIds(arr, 'id', fixture, g.name, issues);
  }
  // Note: deals[].related.{notes,activities} carry inline (non-FK) sub-objects
  // with their own id space — they intentionally do NOT key into the
  // top-level notes/activities arrays, so no cross-ref check applies there.
}

export function runFixtureCheck(): FixtureCheckResult {
  const issues: FixtureIssue[] = [];
  const counter = { items: 0 };
  let fixturesChecked = 0;

  for (const [name, path] of Object.entries(FIXTURE_FILES)) {
    const data = parseJson(path, name, issues);
    if (data === undefined) continue;
    fixturesChecked += 1;

    switch (name) {
      case 'acumatica':
        checkAcumatica(data, name, counter, issues);
        break;
      case 'pipedrive':
        checkPipedrive(data, name, counter, issues);
        break;
      case 'm365-calendar':
        checkArrayFixture(
          data,
          name,
          ['id', 'subject', 'start', 'end'],
          'id',
          counter,
          issues,
        );
        break;
      case 'm365-mail':
        checkArrayFixture(
          data,
          name,
          ['id', 'subject', 'from', 'received_at'],
          'id',
          counter,
          issues,
        );
        break;
      case 'm365-sharepoint':
        checkArrayFixture(
          data,
          name,
          ['id', 'site_id', 'drive_id', 'name', 'web_url'],
          'id',
          counter,
          issues,
        );
        break;
      case 'm365-teams':
        checkArrayFixture(
          data,
          name,
          ['id', 'team_id', 'channel_id', 'author', 'created_at'],
          'id',
          counter,
          issues,
          (items) => {
            const ids = new Set<string>();
            for (const t of items) {
              if (typeof t.id === 'string' || typeof t.id === 'number') ids.add(String(t.id));
            }
            items.forEach((t, idx) => {
              const ref = t.reply_to_id;
              if (ref === null || ref === undefined) return;
              if (typeof ref !== 'string' && typeof ref !== 'number') {
                issues.push({
                  fixture: name,
                  path: `[${idx}].reply_to_id`,
                  message: `reply_to_id must be string|number|null, got ${typeof ref}`,
                });
                return;
              }
              if (!ids.has(String(ref))) {
                issues.push({
                  fixture: name,
                  path: `[${idx}].reply_to_id`,
                  message: `reply_to_id "${ref}" does not resolve to any thread id in this fixture`,
                });
              }
            });
          },
        );
        break;
      case 'supermemory-fs':
        checkArrayFixture(
          data,
          name,
          ['id', 'content'],
          'id',
          counter,
          issues,
        );
        break;
      default:
        issues.push({ fixture: name, path, message: 'no validator registered for this fixture' });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    summary: { fixturesChecked, itemsChecked: counter.items },
  };
}

function formatReport(result: FixtureCheckResult): string {
  if (result.ok) {
    return `fixtures:check OK — ${result.summary.fixturesChecked} fixtures, ${result.summary.itemsChecked} items, 0 issues`;
  }
  const lines: string[] = [
    `fixtures:check FAILED — ${result.summary.fixturesChecked} fixtures scanned, ${result.summary.itemsChecked} items, ${result.issues.length} issue(s):`,
  ];
  for (const issue of result.issues) {
    lines.push(`  [${issue.fixture}] ${issue.path}: ${issue.message}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const result = runFixtureCheck();
  const report = formatReport(result);
  if (result.ok) {
    console.log(report);
    process.exit(0);
  }
  console.error(report);
  process.exit(1);
}

// Run only when invoked directly (not when imported by another module). The
// normalized comparison tolerates Windows vs POSIX path-separator differences
// between process.argv[1] and the URL-derived path.
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
