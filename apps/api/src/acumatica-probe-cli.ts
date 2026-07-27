import { AcumaticaClient } from "@operating-layer/connectors";

/**
 * Operator command: discover what the live Acumatica instance actually exposes
 * on an entity, before any code trusts a field name.
 *
 *   node apps/api/dist/acumatica-probe-cli.js Customer
 *   node apps/api/dist/acumatica-probe-cli.js Invoice
 *
 * This exists because guessing contract-API field names fails loudly and
 * unhelpfully (a 500 "The given key was not present in the dictionary"). It
 * does a bare read of one record with NO $select, prints the field names and
 * a redacted shape, and then reports whether the fields Collections depends on
 * are present. Read-only: one GET plus the auth login/logout pair.
 *
 * Requires the same env as the collections fetch:
 *   ACUMATICA_BASE_URL, ACUMATICA_USERNAME, ACUMATICA_PASSWORD, ACUMATICA_COMPANY
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Field names present on a contract-API record, including one nesting level. */
function describeShape(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, cell] of Object.entries(record)) {
    if (cell && typeof cell === "object" && !("value" in cell)) {
      if (Array.isArray(cell)) {
        out.push(`${key}[] (array of ${cell.length})`);
        continue;
      }
      const inner = Object.keys(cell as Record<string, unknown>);
      out.push(`${key}/{${inner.slice(0, 12).join(",")}}`);
      continue;
    }
    out.push(key);
  }
  return out.sort();
}

/** Fields Collections depends on, per entity. */
const EXPECTED: Record<string, string[]> = {
  Customer: ["CustomerID", "CustomerName", "Status", "MainContact"],
  Invoice: [
    "Type",
    "ReferenceNbr",
    "Customer",
    "LinkBranch",
    "DueDate",
    "Balance",
    "Status",
  ],
};

async function main(): Promise<void> {
  const entity = process.argv[2] ?? "Customer";
  const client = new AcumaticaClient({
    baseUrl: required("ACUMATICA_BASE_URL"),
    username: required("ACUMATICA_USERNAME"),
    password: required("ACUMATICA_PASSWORD"),
    company: process.env.ACUMATICA_COMPANY ?? "Production",
    ...(process.env.ACUMATICA_ENDPOINT_VERSION
      ? { endpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION }
      : {}),
  });

  await client.login();
  let records: Record<string, unknown>[];
  try {
    records = await client.probeEntity(entity, 1);
  } finally {
    await client.logout();
  }

  if (records.length === 0) {
    console.log(`no ${entity} records returned — cannot infer the shape`);
    process.exitCode = 2;
    return;
  }

  const fields = describeShape(records[0]!);
  console.log(`${entity}: ${fields.length} fields on the live instance\n`);
  for (const field of fields) console.log(`  ${field}`);

  const expected = EXPECTED[entity];
  if (expected) {
    console.log(`\nfields Collections depends on:`);
    let missing = 0;
    for (const name of expected) {
      const present = fields.some((f) => f === name || f.startsWith(`${name}/`));
      if (!present) missing += 1;
      console.log(`  ${present ? "OK     " : "MISSING"} ${name}`);
    }
    // The email lives one level down; call it out separately since it is the
    // field that decides whether a chase can be auto-drafted at all.
    if (entity === "Customer") {
      const contact = records[0]!.MainContact;
      const hasEmail =
        !!contact &&
        typeof contact === "object" &&
        "Email" in (contact as Record<string, unknown>);
      console.log(`  ${hasEmail ? "OK     " : "MISSING"} MainContact/Email`);
      if (!hasEmail) missing += 1;
    }
    if (missing > 0) process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
