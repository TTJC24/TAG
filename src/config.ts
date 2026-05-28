import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://company_brain:company_brain@localhost:5432/company_brain'),
  ZEROENTROPY_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  M365_TENANT_ID: z.string().optional(),
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
  M365_USER_PRINCIPAL_NAME: z.string().optional(),
  ACUMATICA_BASE_URL: z.string().optional(),
  ACUMATICA_USERNAME: z.string().optional(),
  ACUMATICA_PASSWORD: z.string().optional(),
  ACUMATICA_TENANT: z.string().optional(),
  ACUMATICA_BRANCH: z.string().optional(),
  PIPEDRIVE_API_TOKEN: z.string().optional(),
  PIPEDRIVE_COMPANY_DOMAIN: z.string().optional(),
  COMPANY_BRAIN_API_TOKEN: z.string().default('dev-local-token'),
  COMPANY_BRAIN_API_PORT: z.coerce.number().int().positive().default(4317),
  SCHEDULER_ENABLED: z.coerce.boolean().default(false),
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
