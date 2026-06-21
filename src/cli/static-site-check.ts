#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

interface SearchIndexEntry {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  url?: unknown;
  sourceSystem?: unknown;
}

interface SearchIndex {
  generatedAt?: unknown;
  entries?: unknown;
}

interface BuildMeta {
  generatedAt?: unknown;
  gitCommitShort?: unknown;
  totalSearchEntries?: unknown;
  countsByType?: unknown;
  countsBySource?: unknown;
}

const REQUIRED_FILES = ['index.html', 'cfo.html', 'search.html', 'search.js', 'search-index.json', 'build-meta.json'];
const REQUIRED_DIRS = ['customer', 'contact', 'deal', 'activity', 'order', 'invoice', 'item', 'vendor', 'rep', 'financial'];
const RAW_MARKUP_TITLE_PATTERNS = [
  /<\s*br\b/i,
  /<\s*a\b/i,
  /<\s*img\b/i,
  /href\s*=/i,
  /img\s+src\s*=/i,
  /&lt;\s*br\b/i,
  /&lt;\s*a\b/i,
  /&lt;\s*img\b/i,
];
const ESCAPED_MARKUP_TEXT_PATTERNS = [
  /&lt;\s*br\b/i,
  /&lt;\s*a\b/i,
  /&lt;\s*img\b/i,
  /href=&quot;/i,
  /img\s+src/i,
];
const EXTERNAL_SEARCH_PATTERNS = [
  /cdn\.jsdelivr/i,
  /\blunr\b/i,
  /<script[^>]+src=["']https?:\/\//i,
  /\sintegrity=["']/i,
];

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isIsoDate(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Date.parse(v));
}

function walkFiles(root: string, predicate: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, predicate, out);
    else if (st.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function assert(condition: unknown, issues: string[], message: string): void {
  if (!condition) issues.push(message);
}

function checkNoExternalSearchDeps(dist: string, issues: string[]): void {
  for (const rel of ['search.html', 'search.js']) {
    const text = readFileSync(path.join(dist, rel), 'utf8');
    for (const pattern of EXTERNAL_SEARCH_PATTERNS) {
      assert(!pattern.test(text), issues, `${rel}: external or unavailable search dependency matched ${pattern}`);
    }
  }
}

function checkSearchIndex(dist: string, minEntries: number, issues: string[]): SearchIndexEntry[] {
  const index = readJson<SearchIndex>(path.join(dist, 'search-index.json'));
  assert(isIsoDate(index.generatedAt), issues, 'search-index.json: generatedAt must be an ISO timestamp');
  assert(Array.isArray(index.entries), issues, 'search-index.json: entries must be an array');
  const entries = Array.isArray(index.entries) ? index.entries as SearchIndexEntry[] : [];
  assert(entries.length >= minEntries, issues, `search-index.json: expected at least ${minEntries} entries, got ${entries.length}`);

  entries.forEach((entry, idx) => {
    assert(typeof entry.type === 'string' && entry.type.length > 0, issues, `search-index.json entries[${idx}]: missing type`);
    assert(typeof entry.id === 'string' && entry.id.length > 0, issues, `search-index.json entries[${idx}]: missing id`);
    assert(typeof entry.name === 'string' && entry.name.trim().length > 0, issues, `search-index.json entries[${idx}]: missing name`);
    assert(typeof entry.url === 'string' && entry.url.startsWith('/'), issues, `search-index.json entries[${idx}]: url must be site-relative`);
    assert(typeof entry.sourceSystem === 'string' && entry.sourceSystem.trim().length > 0, issues, `search-index.json entries[${idx}]: missing sourceSystem`);
    if (typeof entry.name === 'string') {
      for (const pattern of RAW_MARKUP_TITLE_PATTERNS) {
        assert(!pattern.test(entry.name), issues, `search-index.json entries[${idx}]: visible name contains raw markup`);
      }
    }
  });

  return entries;
}

function checkBuildMeta(dist: string, entries: SearchIndexEntry[], expectBuildCommit: boolean, issues: string[]): void {
  const meta = readJson<BuildMeta>(path.join(dist, 'build-meta.json'));
  assert(isIsoDate(meta.generatedAt), issues, 'build-meta.json: generatedAt must be an ISO timestamp');
  assert(meta.totalSearchEntries === entries.length, issues, `build-meta.json: totalSearchEntries ${String(meta.totalSearchEntries)} does not match search index ${entries.length}`);
  assert(isObject(meta.countsByType), issues, 'build-meta.json: countsByType must be an object');
  assert(isObject(meta.countsBySource), issues, 'build-meta.json: countsBySource must be an object');
  if (expectBuildCommit) {
    assert(
      typeof meta.gitCommitShort === 'string' && /^[0-9a-f]{7,40}$/i.test(meta.gitCommitShort),
      issues,
      'build-meta.json: gitCommitShort must be a real Git SHA when --expect-build-commit is set',
    );
  }
}

function checkListingMarkup(dist: string, issues: string[]): void {
  for (const dir of REQUIRED_DIRS) {
    const listing = path.join(dist, dir, 'index.html');
    if (!existsSync(listing)) continue;
    const html = readFileSync(listing, 'utf8');
    for (const pattern of ESCAPED_MARKUP_TEXT_PATTERNS) {
      assert(!pattern.test(html), issues, `${dir}/index.html: listing contains raw markup-looking title text`);
    }
  }
}

function checkDetailFilesExistForSearchUrls(dist: string, entries: SearchIndexEntry[], issues: string[]): void {
  const missing = entries
    .map((entry) => typeof entry.url === 'string' ? entry.url : '')
    .filter((url) => url.startsWith('/'))
    .filter((url) => !existsSync(path.join(dist, url.replace(/^\//, ''))));
  for (const url of missing.slice(0, 20)) {
    issues.push(`search-index.json: url does not exist in dist: ${url}`);
  }
  if (missing.length > 20) issues.push(`search-index.json: ${missing.length - 20} additional missing urls`);
}

function main(): void {
  const dist = path.resolve(argValue('dist', 'dist') ?? 'dist');
  const minEntries = Number.parseInt(argValue('min-search-entries', '0') ?? '0', 10);
  const expectBuildCommit = hasFlag('expect-build-commit');
  const issues: string[] = [];

  assert(existsSync(dist), issues, `dist directory does not exist: ${dist}`);
  if (issues.length === 0) {
    for (const rel of REQUIRED_FILES) {
      assert(existsSync(path.join(dist, rel)), issues, `missing required file: ${rel}`);
    }
    for (const rel of REQUIRED_DIRS) {
      assert(existsSync(path.join(dist, rel)), issues, `missing required directory: ${rel}/`);
    }
  }
  if (issues.length > 0) {
    console.error(`static:check FAILED for ${dist}`);
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  try {
    checkNoExternalSearchDeps(dist, issues);
    const entries = checkSearchIndex(dist, minEntries, issues);
    checkBuildMeta(dist, entries, expectBuildCommit, issues);
    checkListingMarkup(dist, issues);
    checkDetailFilesExistForSearchUrls(dist, entries, issues);
    const htmlFiles = walkFiles(dist, (file) => file.endsWith('.html'));
    assert(htmlFiles.length >= REQUIRED_DIRS.length + 2, issues, `expected generated HTML files, got ${htmlFiles.length}`);
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  if (issues.length > 0) {
    console.error(`static:check FAILED for ${dist}`);
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    dist,
    minSearchEntries: minEntries,
    expectBuildCommit,
  }, null, 2));
}

main();
