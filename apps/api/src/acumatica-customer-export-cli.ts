import { writeFileSync } from "node:fs";
import {
  AcumaticaClient,
  resolveAcumaticaGuard,
  withAcumaticaRunLock,
  type AcumaticaCustomerLocation,
} from "@operating-layer/connectors";

/**
 * Operator command: export the Acumatica customer master as an identity
 * reference, so systems outside the ERP can resolve a name to a real customer.
 *
 *   node apps/api/dist/acumatica-customer-export-cli.js > customers.json
 *   node apps/api/dist/acumatica-customer-export-cli.js --out customers.json
 *   node apps/api/dist/acumatica-customer-export-cli.js --csv > customers.csv
 *
 * Why this exists: downstream systems key customers by NAME, and a name is not
 * an identity. One legal customer routinely appears as many look-alike records
 * — legal-suffix variants, import duplicates, and genuinely distinct yards.
 * Fuzzy-matching a name against that set has no correct answer. The ERP
 * customer id is the only stable key, so anything that wants to join to money
 * has to carry it.
 *
 * Locations are exported as children rather than flattened, because the two
 * kinds of duplication are different: "Co. LLC" vs "Co.LLC" is noise to be
 * collapsed, while Crystal River vs Ocala are real places that must stay
 * distinct under one customer.
 *
 * READ-ONLY. Reads Customer and CustomerLocation and writes a local file. It
 * changes nothing in the ERP.
 *
 * NOTE: the output contains customer names and contact emails. Treat it as
 * business data — do not commit it to git.
 *
 * Requires: ACUMATICA_BASE_URL, ACUMATICA_USERNAME, ACUMATICA_PASSWORD,
 * ACUMATICA_COMPANY. Optional: ACUMATICA_ENDPOINT_VERSION.
 */

interface ExportedCustomer {
  acumaticaCustomerId: string;
  name: string | null;
  status: string | null;
  email: string | null;
  locations: Array<{
    locationId: string;
    name: string | null;
    status: string | null;
    shippingBranch: string | null;
    active: boolean | null;
  }>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** CSV with one row per customer-location, flattened for spreadsheet review. */
function toCsv(customers: ExportedCustomer[]): string {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [
    [
      "acumatica_customer_id",
      "customer_name",
      "status",
      "email",
      "location_id",
      "location_name",
      "location_status",
      "shipping_branch",
      "location_active",
    ].join(","),
  ];
  for (const customer of customers) {
    if (customer.locations.length === 0) {
      rows.push(
        [
          customer.acumaticaCustomerId,
          customer.name,
          customer.status,
          customer.email,
          "",
          "",
          "",
          "",
          "",
        ]
          .map(escape)
          .join(","),
      );
      continue;
    }
    for (const location of customer.locations) {
      rows.push(
        [
          customer.acumaticaCustomerId,
          customer.name,
          customer.status,
          customer.email,
          location.locationId,
          location.name,
          location.status,
          location.shippingBranch,
          location.active,
        ]
          .map(escape)
          .join(","),
      );
    }
  }
  return rows.join("\n");
}

async function main(): Promise<void> {
  const asCsv = process.argv.includes("--csv");
  const outPath = arg("--out");

  const guard = resolveAcumaticaGuard();
  const client = new AcumaticaClient({
    baseUrl: required("ACUMATICA_BASE_URL"),
    username: required("ACUMATICA_USERNAME"),
    password: required("ACUMATICA_PASSWORD"),
    company: process.env.ACUMATICA_COMPANY ?? "Production",
    breaker: guard.breaker,
    ...(process.env.ACUMATICA_ENDPOINT_VERSION
      ? { endpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION }
      : {}),
  });

  let locationsByCustomer = new Map<string, AcumaticaCustomerLocation[]>();
  let locationsAvailable = true;
  let locationError = "";
  // Under the exclusive lock: this command logs in, so it must not run beside
  // the scheduled feed or a hand-run preflight.
  const customers = await withAcumaticaRunLock(
    guard,
    "customer-export",
    async () => {
      await client.login();
      try {
        const read = await client.fetchCustomers();
        // A tenant that does not use multi-location customers may not expose
        // this entity. Degrade to a customer-only export and SAY SO rather than
        // silently shipping a reference that looks complete but is not.
        try {
          locationsByCustomer = await client.fetchCustomerLocations();
        } catch (error) {
          locationsAvailable = false;
          locationError = error instanceof Error ? error.message : "unknown";
        }
        return read;
      } finally {
        await client.logout();
      }
    },
  );

  const exported: ExportedCustomer[] = [...customers.values()]
    .map((customer) => ({
      acumaticaCustomerId: customer.customerId,
      name: customer.customerName,
      status: customer.status,
      email: customer.email,
      locations: (locationsByCustomer.get(customer.customerId) ?? []).map(
        (location) => ({
          locationId: location.locationId,
          name: location.locationName,
          status: location.status,
          shippingBranch: location.shippingBranch,
          active: location.active,
        }),
      ),
    }))
    .sort((a, b) => a.acumaticaCustomerId.localeCompare(b.acumaticaCustomerId));

  const totalLocations = exported.reduce(
    (sum, customer) => sum + customer.locations.length,
    0,
  );
  const multiLocation = exported.filter((c) => c.locations.length > 1).length;

  console.error(
    `exported ${exported.length} customers, ${totalLocations} locations (${multiLocation} customers have more than one)`,
  );
  if (!locationsAvailable) {
    console.error(
      `WARNING: the CustomerLocation entity could not be read (${locationError}).`,
    );
    console.error(
      "The export is customer-only. Any customer with multiple physical sites will look like one row, which is exactly the ambiguity this export exists to remove — run acumatica-probe-cli CustomerLocation to see what this instance exposes.",
    );
  }

  const payload = asCsv
    ? toCsv(exported)
    : JSON.stringify(
        {
          source: "acumatica",
          company: process.env.ACUMATICA_COMPANY ?? "Production",
          locationsIncluded: locationsAvailable,
          customerCount: exported.length,
          locationCount: totalLocations,
          customers: exported,
        },
        null,
        2,
      );

  if (outPath) {
    writeFileSync(outPath, payload, "utf8");
    console.error(
      `written to ${outPath} — contains customer data, do not commit`,
    );
  } else {
    console.log(payload);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
