#!/usr/bin/env bun
/**
 * Company Brain v3 — static page generator (Phase 2B).
 *
 * Renders every customer / order / invoice / item record in the brain
 * (plus reserved-but-empty vendor / rep surfaces) into a self-contained
 * static site under `dist/`. No server runtime is required to view the
 * output — open `dist/index.html` in a browser, or push the whole `dist/`
 * folder to Cloudflare Pages.
 *
 * Run from the repo root:
 *   QUERY_DATABASE_URL=postgres://company_brain_reader:...@host/company_brain \
 *     bun run pagegen
 *
 * On the jerry-data droplet, the docker-compose ingest container already
 * has the reader URL in scope; `docker compose exec company-brain-ingest
 * bun run pagegen` does the right thing.
 *
 * Exit codes:
 *   0 — site written
 *   1 — DB unreachable / unrecoverable error
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadAllPages, openReaderPool, type RawPage } from './db.ts';
import {
  buildRelations,
  classifyAll,
  cleanVisibleText,
  type ClassifiedBuckets,
  type ClassifiedEntity,
} from './classify.ts';
import { classifyFreshness } from './freshness.ts';
import {
  entityHref,
  renderEntityDetail,
  renderHome,
  renderSearchPage,
  renderTypeListing,
  safeSlug,
  searchClientSource,
  styleSheetSource,
  type BuildMeta,
} from './render.ts';

const OUT_DIR = process.env.PAGEGEN_OUT_DIR ?? 'dist';
const TYPES = ['customer', 'deal', 'contact', 'activity', 'order', 'invoice', 'item', 'vendor', 'rep', 'financial'] as const;

interface SearchIndexEntry {
  type: string;
  id: string;
  name: string;
  keywords: string;
  url: string;
  sourceSystem: string;
  lastRefreshedUtc: string | null;
  freshnessStatus: 'fresh' | 'recent' | 'stale' | 'unknown';
}

function log(msg: string): void {
  // Single channel; stderr is for errors only so docker compose logs stay clean.
  process.stdout.write(`[pagegen] ${msg}\n`);
}

function logError(msg: string): void {
  process.stderr.write(`[pagegen] ERROR: ${msg}\n`);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function clearDir(p: string): Promise<void> {
  await ensureDir(p);
  const entries = await readdir(p);
  await Promise.all(entries.map((entry) => rm(path.join(p, entry), { recursive: true, force: true })));
}

function bucketFor(buckets: ClassifiedBuckets, type: string): ClassifiedEntity[] {
  switch (type) {
    case 'customer': return buckets.customers;
    case 'order': return buckets.orders;
    case 'invoice': return buckets.invoices;
    case 'item': return buckets.items;
    case 'vendor': return buckets.vendors;
    case 'rep': return buckets.reps;
    case 'deal': return buckets.deals;
    case 'contact': return buckets.contacts;
    case 'activity': return buckets.activities;
    case 'financial': return buckets.financials;
    default: return [];
  }
}

function searchKeywords(entity: ClassifiedEntity): string {
  // Compact tokenized "keywords" string Lunr can match against. Includes id,
  // title, source kind, and a flattened list of structured field values.
  const parts: string[] = [entity.id, entity.title, entity.sourceSystem, entity.sourceKind]
    .map((part) => cleanVisibleText(part))
    .filter((part) => part.length > 0);
  for (const [k, v] of Object.entries(entity.fields)) {
    const clean = cleanVisibleText(v);
    if (clean.length > 0) parts.push(k, clean);
  }
  // Keep size sane: cap each entry's keywords at 2kb. The full markdown body
  // can be huge for some sources (SharePoint extracted text). Anything past
  // the cap is not very useful for search anyway.
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function buildSearchIndex(buckets: ClassifiedBuckets, generatedAt: Date): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];
  for (const type of TYPES) {
    const list = bucketFor(buckets, type);
    for (const e of list) {
      const freshness = classifyFreshness(e.upstreamUpdatedAt, e.pageUpdatedAt, generatedAt);
      entries.push({
        type,
        id: e.id,
        name: cleanVisibleText(e.title) || 'Untitled record',
        keywords: searchKeywords(e),
        url: entityHref(type, e.fileSlug),
        sourceSystem: e.sourceSystem,
        lastRefreshedUtc:
          freshness.upstreamUpdatedAt?.toISOString().replace('.000Z', 'Z') ??
          (freshness.reference === 'ingest'
            ? e.pageUpdatedAt.toISOString().replace('.000Z', 'Z')
            : null),
        freshnessStatus: freshness.status,
      });
    }
  }
  return entries;
}

function gitCommitShort(): string | null {
  const envCommit = process.env.COMPANY_BRAIN_GIT_COMMIT?.trim();
  if (envCommit && /^[0-9a-f]{7,40}$/i.test(envCommit)) return envCommit;

  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const value = result.stdout?.trim();
  return result.status === 0 && value ? value : null;
}

function countsByType(buckets: ClassifiedBuckets): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of TYPES) counts[type] = bucketFor(buckets, type).length;
  return counts;
}

function countsBySource(buckets: ClassifiedBuckets): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of TYPES) {
    for (const entity of bucketFor(buckets, type)) {
      const key = entity.sourceInstance
        ? `${entity.sourceSystem} (${entity.sourceInstance})`
        : entity.sourceSystem;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function writeStaticAssets(outDir: string): Promise<void> {
  await writeFile(path.join(outDir, 'styles.css'), styleSheetSource(), 'utf8');
  await writeFile(path.join(outDir, 'search.js'), searchClientSource(), 'utf8');
}

async function writeEntityPages(
  outDir: string,
  type: string,
  entities: ClassifiedEntity[],
  buckets: ClassifiedBuckets,
  generatedAt: Date,
  buildMeta: BuildMeta,
): Promise<{ pagesWritten: number; idCollisions: number }> {
  const typeDir = path.join(outDir, type);
  await ensureDir(typeDir);

  // Listing page (also handles empty state via renderTypeListing)
  await writeFile(
    path.join(typeDir, 'index.html'),
    renderTypeListing(type, entities, generatedAt, buildMeta),
    'utf8',
  );

  if (entities.length === 0) {
    return { pagesWritten: 0, idCollisions: 0 };
  }

  const relations = buildRelations(buckets);
  const usedSlugs = new Set<string>();
  let pagesWritten = 0;
  let idCollisions = 0;

  for (const e of entities) {
    let slug = safeSlug(e.fileSlug);
    if (usedSlugs.has(slug)) {
      // Two entities slugged to the same filename. Disambiguate with the
      // page slug suffix. This should be very rare in practice; we log it.
      idCollisions += 1;
      slug = `${slug}-${safeSlug(e.pageSlug).slice(-12)}`;
    }
    usedSlugs.add(slug);
    const html = renderEntityDetail(type, e, relations, generatedAt, buildMeta);
    await writeFile(path.join(typeDir, `${slug}.html`), html, 'utf8');
    pagesWritten += 1;
  }

  return { pagesWritten, idCollisions };
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const generatedAt = new Date();
  const absOutDir = path.resolve(OUT_DIR);

  log(`output directory: ${absOutDir}`);
  log(`connecting to Postgres as company_brain_reader (read-only)...`);

  const pool = openReaderPool();
  let pages: RawPage[];
  try {
    pages = await loadAllPages(pool);
  } catch (err) {
    logError(`failed to load pages: ${err instanceof Error ? err.message : err}`);
    logError('hint: confirm QUERY_DATABASE_URL points at a reachable Postgres and the role is company_brain_reader.');
    await pool.end().catch(() => {});
    process.exit(1);
  }
  log(`loaded ${pages.length} pages from public.pages`);

  const buckets = classifyAll(pages);
  log(
      `classified: customers=${buckets.customers.length} orders=${buckets.orders.length} ` +
      `invoices=${buckets.invoices.length} items=${buckets.items.length} ` +
      `vendors=${buckets.vendors.length} reps=${buckets.reps.length} ` +
      `deals=${buckets.deals.length} contacts=${buckets.contacts.length} ` +
      `activities=${buckets.activities.length} financials=${buckets.financials.length} ` +
      `other=${buckets.other.length}`,
  );

  await clearDir(absOutDir);
  await writeStaticAssets(absOutDir);
  log('wrote styles.css + search.js');

  const searchEntries = buildSearchIndex(buckets, generatedAt);
  const buildMeta: BuildMeta = {
    generatedAt: generatedAt.toISOString(),
    gitCommitShort: gitCommitShort(),
    totalSearchEntries: searchEntries.length,
    countsByType: countsByType(buckets),
    countsBySource: countsBySource(buckets),
    pagegenDurationMs: null,
  };

  // Home
  await writeFile(
    path.join(absOutDir, 'index.html'),
    renderHome(buckets, generatedAt, pages.length, buildMeta),
    'utf8',
  );
  // Search shell
  await writeFile(
    path.join(absOutDir, 'search.html'),
    renderSearchPage(generatedAt, buildMeta),
    'utf8',
  );
  log('wrote index.html + search.html');

  // Per-type listings + per-record details
  let totalPagesWritten = 0;
  let totalCollisions = 0;
  for (const type of TYPES) {
    const list = bucketFor(buckets, type);
    const { pagesWritten, idCollisions } = await writeEntityPages(
      absOutDir,
      type,
      list,
      buckets,
      generatedAt,
      buildMeta,
    );
    totalPagesWritten += pagesWritten;
    totalCollisions += idCollisions;
    log(
      `wrote /${type}/index.html + ${pagesWritten} detail page${
        pagesWritten === 1 ? '' : 's'
      }${idCollisions > 0 ? ` (${idCollisions} slug collision${idCollisions === 1 ? '' : 's'} disambiguated)` : ''}`,
    );
  }

  const elapsedMs = Date.now() - startMs;
  buildMeta.pagegenDurationMs = elapsedMs;

  // Re-render the top-level pages after duration is known, so the homepage
  // status panel and footer reflect the final snapshot metadata.
  await writeFile(
    path.join(absOutDir, 'index.html'),
    renderHome(buckets, generatedAt, pages.length, buildMeta),
    'utf8',
  );
  await writeFile(
    path.join(absOutDir, 'search.html'),
    renderSearchPage(generatedAt, buildMeta),
    'utf8',
  );

  // Search index + build metadata
  await writeFile(
    path.join(absOutDir, 'search-index.json'),
    JSON.stringify(
      {
        generatedAt: generatedAt.toISOString(),
        entries: searchEntries,
      },
      null,
      0,
    ),
    'utf8',
  );
  log(`wrote search-index.json (${searchEntries.length} entries)`);

  await writeFile(
    path.join(absOutDir, 'build-meta.json'),
    JSON.stringify(buildMeta, null, 2),
    'utf8',
  );
  log('wrote build-meta.json');

  await pool.end();

  log(
    `done in ${elapsedMs}ms — ${totalPagesWritten} detail pages + ${TYPES.length} listings + home + search.`,
  );
  if (totalCollisions > 0) {
    log(
      `note: ${totalCollisions} slug collision${totalCollisions === 1 ? '' : 's'} were disambiguated. Two entities mapped to the same filename; suffix added.`,
    );
  }
  if (buckets.other.length > 0) {
    log(
      `note: ${buckets.other.length} record${buckets.other.length === 1 ? '' : 's'} did not map to a v3 static surface. These are still in the brain DB and searchable via the SQL endpoint.`,
    );
  }
}

main().catch(async (err) => {
  logError(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
