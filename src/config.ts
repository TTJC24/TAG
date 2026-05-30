import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';

function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://company_brain:company_brain@localhost:5432/company_brain'),
  COMPANY_BRAIN_ENGINE: z.enum(['postgres', 'json']).default('json'),
  ZEROENTROPY_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  M365_TENANT_ID: z.string().optional(),
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
  M365_USER_PRINCIPAL_NAME: z.string().optional(),
  M365_USER_PRINCIPAL_NAMES: z.string().optional(),
  M365_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  M365_SHAREPOINT_MAX_DOWNLOAD_BYTES: z.coerce.number().int().positive().default(1_000_000),
  ACUMATICA_BASE_URL: z.string().optional(),
  ACUMATICA_ENDPOINT_VERSION: z.string().default('24.200.001'),
  ACUMATICA_USERNAME: z.string().optional(),
  ACUMATICA_PASSWORD: z.string().optional(),
  ACUMATICA_TENANT: z.string().optional(),
  ACUMATICA_BRANCH: z.string().optional(),
  ACUMATICA_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  PIPEDRIVE_API_TOKEN: z.string().optional(),
  PIPEDRIVE_COMPANY_DOMAIN: z.string().optional(),
  PIPEDRIVE_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  COMPANY_BRAIN_API_TOKEN: z.string().default('dev-local-token'),
  COMPANY_BRAIN_API_PORT: z.coerce.number().int().positive().default(4317),
  PROCUREMENT_STORE_PATH: z.string().optional(),
  SCHEDULER_ENABLED: envBoolean.default(false),
  SCHEDULER_DRY_RUN: envBoolean.default(true),
  SCHEDULER_NO_EMBED: envBoolean.default(true),
  SCHEDULER_SOURCES: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export function requireEnv<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required env: ${key}`);
  }
  return value as NonNullable<Config[K]>;
}
