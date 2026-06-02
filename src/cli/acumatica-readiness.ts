#!/usr/bin/env bun
import { config, entityBranch, requireEnv, type EntityCode } from '../config.ts';

const BRANCHES: EntityCode[] = ['FS', 'BLCS', 'USA'];

interface LoginResult {
  cookie: string;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function cookieHeader(raw: string | null): string {
  if (!raw) return '';
  return raw
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function sanitizeErrorText(value: string): string {
  return value
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[redacted]"')
    .replace(/"name"\s*:\s*"[^"]*"/gi, '"name":"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function requiredEnvNames(): string[] {
  return [
    'ACUMATICA_BASE_URL',
    'ACUMATICA_USERNAME',
    'ACUMATICA_PASSWORD',
    'ACUMATICA_TENANT',
    'ACUMATICA_BRANCH_FS',
    'ACUMATICA_BRANCH_BLCS',
    'ACUMATICA_BRANCH_USA',
  ];
}

function printConfigSummary(): void {
  console.log('Acumatica readiness check');
  console.log(`- Base URL: ${normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'))}`);
  console.log(`- Tenant/company: ${config.ACUMATICA_TENANT}`);
  console.log(`- Endpoint version: ${config.ACUMATICA_ENDPOINT_VERSION}`);
  console.log(`- Branches: FS=${entityBranch('FS')}, BLCS=${entityBranch('BLCS')}, USA=${entityBranch('USA')}`);
}

async function loginOnce(base: string): Promise<LoginResult> {
  const body = {
    name: requireEnv('ACUMATICA_USERNAME'),
    password: requireEnv('ACUMATICA_PASSWORD'),
    company: requireEnv('ACUMATICA_TENANT'),
  };
  let res: Response;
  try {
    res = await fetch(`${base}/entity/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`login network error: ${err instanceof Error ? sanitizeErrorText(err.message) : sanitizeErrorText(String(err))}`);
  }

  if (!res.ok) {
    const text = sanitizeErrorText(await res.text());
    const limitHint = /api login limit|login limit|maximum number/i.test(text)
      ? ' This usually means the integration user has exhausted Acumatica API sessions/seats; do not retry-loop. Ask the Acumatica admin/support to clear sessions or provision a dedicated API user.'
      : '';
    throw new Error(`login failed: HTTP ${res.status} ${text}${limitHint}`);
  }

  const cookie = cookieHeader(res.headers.get('set-cookie'));
  if (!cookie) throw new Error('login succeeded but no session cookie was returned');
  return { cookie };
}

async function smokeBranch(base: string, cookie: string, entity: EntityCode): Promise<void> {
  const branch = entityBranch(entity);
  const endpoint = `${base}/entity/Default/${config.ACUMATICA_ENDPOINT_VERSION}/Customer?$top=1`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        'PX-CbApiBranch': branch,
      },
    });
  } catch (err) {
    throw new Error(`${entity} (${branch}) read network error: ${err instanceof Error ? sanitizeErrorText(err.message) : sanitizeErrorText(String(err))}`);
  }

  if (!res.ok) {
    const text = sanitizeErrorText(await res.text());
    throw new Error(`${entity} (${branch}) read failed: HTTP ${res.status} ${text}`);
  }

  const rows = (await res.json()) as unknown;
  const count = Array.isArray(rows) ? rows.length : 0;
  console.log(`- ${entity} (${branch}): read OK, Customer $top=1 returned ${count} row${count === 1 ? '' : 's'}`);
}

async function logoutBestEffort(base: string, cookie: string): Promise<void> {
  try {
    await fetch(`${base}/entity/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
  } catch {
    // Best effort only. Readiness result is based on login + read checks.
  }
}

async function main(): Promise<void> {
  for (const key of requiredEnvNames()) requireEnv(key as keyof typeof config);
  printConfigSummary();
  console.log('Attempting exactly one Acumatica login...');

  const base = normalizeBaseUrl(requireEnv('ACUMATICA_BASE_URL'));
  const { cookie } = await loginOnce(base);
  console.log('- Login: OK');

  try {
    for (const entity of BRANCHES) await smokeBranch(base, cookie, entity);
    console.log('Acumatica readiness: PASS');
  } finally {
    await logoutBestEffort(base, cookie);
  }
}

main().catch((err) => {
  console.error(`Acumatica readiness: FAIL - ${err instanceof Error ? sanitizeErrorText(err.message) : sanitizeErrorText(String(err))}`);
  process.exit(1);
});
