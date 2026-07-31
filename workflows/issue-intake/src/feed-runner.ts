import {
  AcumaticaClient,
  PipedriveClient,
  resolveAcumaticaGuard,
  withAcumaticaRunLock,
} from "@operating-layer/connectors";
import type { DatabasePool } from "@operating-layer/db";
import { buildAgingFromInvoices } from "./acumatica-aging.js";
import {
  resolveCollectionsConfig,
  syncArAging,
  type CollectionsSyncResult,
} from "./ar-collections.js";
import {
  resolvePipedriveSalesConfig,
  resolvePipedriveSources,
  syncPipedriveDeals,
  type PipedriveSalesSyncResult,
} from "./pipedrive-sales.js";
import { loadOrganizationIdsByCode } from "./traction-bridge.js";

/**
 * One place that knows how to refresh a feed, so the operator CLI and the
 * scheduled worker run exactly the same code path. Before this, the pull only
 * existed inside a CLI's main(), which is why "make it automatic" meant
 * "remember to run the command".
 *
 * Read-only and governed: this logs into Acumatica, reads AR, and raises the
 * same governed issues the manual command raises. It sends nothing, and every
 * chase it raises still requires the same human approval.
 */

export interface CollectionsFeedResult {
  readInvoices: number;
  readCustomers: number;
  customersWithEmail: number;
  perCompany: CollectionsSyncResult[];
}

export interface AcumaticaEnv {
  ACUMATICA_BASE_URL?: string;
  ACUMATICA_USERNAME?: string;
  ACUMATICA_PASSWORD?: string;
  ACUMATICA_COMPANY?: string;
  ACUMATICA_ENDPOINT_VERSION?: string;
  COLLECTIONS_ASOF?: string;
}

function required(env: AcumaticaEnv, name: keyof AcumaticaEnv): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Pull open AR from Acumatica, age it, and run each company through the
 * Collections doorway. Returns what happened so the caller can log a single
 * structured line rather than a pile of console noise.
 */
export async function runCollectionsFeed(
  pool: DatabasePool,
  env: AcumaticaEnv & Record<string, string | undefined> = process.env as never,
): Promise<CollectionsFeedResult> {
  const config = resolveCollectionsConfig(env as never);
  const guard = resolveAcumaticaGuard(env);
  const client = new AcumaticaClient({
    baseUrl: required(env, "ACUMATICA_BASE_URL"),
    username: required(env, "ACUMATICA_USERNAME"),
    password: required(env, "ACUMATICA_PASSWORD"),
    company: env.ACUMATICA_COMPANY ?? "Production",
    breaker: guard.breaker,
    ...(env.ACUMATICA_ENDPOINT_VERSION
      ? { endpointVersion: env.ACUMATICA_ENDPOINT_VERSION }
      : {}),
  });
  const asOf = env.COLLECTIONS_ASOF ?? new Date().toISOString().slice(0, 10);

  // This is the unattended path, so the guard matters most here. A tripped
  // breaker stops the scheduled run cold rather than retrying every night into
  // a locked account, and the lock stops it colliding with a hand-run command.
  //
  // Deliberately NOT caught: a blocked run must fail loudly and leave the
  // breaker tripped. Swallowing it would produce a worker that quietly does
  // nothing every night while reporting success.
  const { invoices, contacts } = await withAcumaticaRunLock(
    guard,
    "collections-feed",
    async () => {
      await client.login();
      try {
        const read = await client.fetchOpenArInvoices();
        // Names and addresses are a nice-to-have on top of the AR truth:
        // losing them degrades chases to id-labelled and unaddressed, but must
        // not lose the run.
        try {
          return { invoices: read, contacts: await client.fetchCustomers() };
        } catch {
          return { invoices: read, contacts: undefined };
        }
      } finally {
        await client.logout();
      }
    },
  );

  const agingByCompany = buildAgingFromInvoices(invoices, asOf, {
    ...(contacts ? { contacts } : {}),
  });
  const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
  const perCompany: CollectionsSyncResult[] = [];
  for (const aging of agingByCompany) {
    perCompany.push(
      await syncArAging(pool, aging, config, organizationIdsByCode),
    );
  }

  return {
    readInvoices: invoices.length,
    readCustomers: contacts?.size ?? 0,
    customersWithEmail: contacts
      ? [...contacts.values()].filter((c) => c.email).length
      : 0,
    perCompany,
  };
}

export interface SalesFeedResult {
  perSource: Array<{ source: string } & PipedriveSalesSyncResult>;
}

/**
 * Pull open deals from every configured Pipedrive account and run them through
 * the Sales doorway. Read-only; nothing is written back to Pipedrive.
 */
export async function runSalesFeed(
  pool: DatabasePool,
  env: Record<string, string | undefined> = process.env,
): Promise<SalesFeedResult> {
  const config = resolvePipedriveSalesConfig(env as never);
  const sources = resolvePipedriveSources(env as never);
  const asOf =
    env.PIPEDRIVE_SALES_ASOF ?? new Date().toISOString().slice(0, 10);

  const organizationIdsByCode = await loadOrganizationIdsByCode(pool);
  const perSource: SalesFeedResult["perSource"] = [];
  for (const source of sources) {
    const client = new PipedriveClient({
      apiBase: source.apiBase,
      apiToken: source.token,
    });
    const deals = await client.fetchOpenDeals();
    const result = await syncPipedriveDeals(
      pool,
      deals,
      config,
      organizationIdsByCode,
      asOf,
      {
        ...(source.orgCode ? { orgCode: source.orgCode } : {}),
        ...(source.pipelineToOrgCode
          ? { pipelineToOrgCode: source.pipelineToOrgCode }
          : {}),
        ...(source.serviceUserEmail
          ? { serviceUserEmail: source.serviceUserEmail }
          : {}),
      },
    );
    perSource.push({ source: source.name, ...result });
  }
  return { perSource };
}
