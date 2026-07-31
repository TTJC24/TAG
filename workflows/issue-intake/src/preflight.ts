import { withOrganizationScope, type DatabasePool } from "@operating-layer/db";
import { resolveApplicationPrincipal } from "./identity.js";

/**
 * Connector and platform preflight — "does this thing actually work against the
 * real systems?"
 *
 * Every check here is READ-ONLY and safe to run repeatedly, including in
 * production. Nothing writes, nothing sends, nothing enqueues. The point is to
 * answer, in one command, whether each wire authenticates, returns the shape we
 * depend on, and would produce sane work — before anyone turns a doorway on.
 *
 * Checks report rather than throw: one dead wire should not hide the state of
 * the others. A run returns every result plus a rollup.
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  section: string;
  name: string;
  status: CheckStatus;
  detail: string;
  /** Concrete numbers/values observed, so a pass is verifiable, not asserted. */
  evidence?: Record<string, unknown>;
}

export interface PreflightReport {
  results: CheckResult[];
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  /** True when nothing failed. Warnings do not block. */
  ok: boolean;
}

export function summarize(results: CheckResult[]): PreflightReport {
  const count = (status: CheckStatus) =>
    results.filter((r) => r.status === status).length;
  const failed = count("fail");
  return {
    results,
    passed: count("pass"),
    failed,
    warned: count("warn"),
    skipped: count("skip"),
    ok: failed === 0,
  };
}

/** Run a check, converting a thrown error into a `fail` rather than exploding. */
export async function check(
  section: string,
  name: string,
  fn: () => Promise<Omit<CheckResult, "section" | "name">>,
): Promise<CheckResult> {
  try {
    return { section, name, ...(await fn()) };
  } catch (error) {
    return {
      section,
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : "check threw",
    };
  }
}

// ---------------------------------------------------------------------------
// Platform: the database, its safety invariants, and the governance core
// ---------------------------------------------------------------------------

const EXPECTED_MIGRATION_TABLES = [
  "organizations",
  "users",
  "tasks",
  "workflows",
  "approvals",
  "recommendations",
  "outbox_events",
  "execution_commands",
  "source_systems",
  "approval_policy_versions",
  "collections_chase_proposals",
];

export async function checkPlatform(
  pool: DatabasePool,
  opts: {
    /**
     * A provisioned OS user to check governance visibility as. Required because
     * the governance tables are org-scoped under row-level security: counting
     * them without an org context returns zero whether or not rows exist, so a
     * scope-less check would report a false failure.
     */
    serviceUserEmail?: string;
  } = {},
): Promise<CheckResult[]> {
  const section = "platform";
  const results: CheckResult[] = [];

  results.push(
    await check(section, "database reachable", async () => {
      const r = await pool.query("SELECT current_user, version()");
      return {
        status: "pass",
        detail: `connected as ${r.rows[0].current_user}`,
        evidence: { version: String(r.rows[0].version).split(",")[0] },
      };
    }),
  );

  // The runtime identity must NOT be able to bypass row-level security. This is
  // the single most important platform invariant: org isolation is only real if
  // the role the app connects as is subject to it.
  results.push(
    await check(section, "runtime role cannot bypass RLS", async () => {
      const r = await pool.query(
        `SELECT rolsuper, rolbypassrls, rolname
           FROM pg_roles WHERE rolname = current_user`,
      );
      const row = r.rows[0];
      const unsafe = row?.rolsuper === true || row?.rolbypassrls === true;
      return {
        status: unsafe ? "fail" : "pass",
        detail: unsafe
          ? `role ${row.rolname} is superuser/BYPASSRLS — org isolation is NOT enforced`
          : `role ${row.rolname} is non-privileged`,
        evidence: { superuser: row?.rolsuper, bypassrls: row?.rolbypassrls },
      };
    }),
  );

  results.push(
    await check(section, "schema present (migrations applied)", async () => {
      const r = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'operating_layer'`,
      );
      const present = new Set(r.rows.map((row) => String(row.tablename)));
      const missing = EXPECTED_MIGRATION_TABLES.filter((t) => !present.has(t));
      return {
        status: missing.length === 0 ? "pass" : "fail",
        detail:
          missing.length === 0
            ? `${present.size} tables present`
            : `missing: ${missing.join(", ")}`,
        evidence: { tableCount: present.size, missing },
      };
    }),
  );

  results.push(
    await check(section, "row-level security forced", async () => {
      const r = await pool.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'operating_layer' AND c.relkind = 'r'
            AND c.relname IN ('tasks','approvals','collections_chase_proposals')`,
      );
      const weak = r.rows.filter(
        (row) => !row.relrowsecurity || !row.relforcerowsecurity,
      );
      return {
        status: weak.length === 0 ? "pass" : "fail",
        detail:
          weak.length === 0
            ? `RLS enabled and FORCED on ${r.rows.length} core tables`
            : `not forced on: ${weak.map((w) => w.relname).join(", ")}`,
        evidence: { checked: r.rows.length },
      };
    }),
  );

  results.push(
    await check(section, "organizations seeded", async () => {
      const r = await pool.query(
        `SELECT code, status FROM operating_layer.organizations ORDER BY code`,
      );
      const codes = r.rows.map((row) => String(row.code));
      return {
        status: codes.length > 0 ? "pass" : "fail",
        detail:
          codes.length > 0 ? `${codes.join(", ")}` : "no organizations seeded",
        evidence: { codes },
      };
    }),
  );

  // Governance core: without these the doorways fail at intake with
  // manual_source_unavailable / policy errors rather than anything obvious.
  //
  // These tables are org-scoped under forced RLS, so they MUST be counted from
  // inside an organization scope — exactly as a doorway sees them. Counting
  // without a scope always returns zero and would report a false failure.
  results.push(
    await check(section, "governed intake infrastructure", async () => {
      if (!opts.serviceUserEmail) {
        return {
          status: "skip",
          detail:
            "set COLLECTIONS_USER_EMAIL (or PREFLIGHT_USER_EMAIL) to verify governance visibility — these tables are RLS-scoped and cannot be counted without an org context",
        };
      }
      const principal = await resolveApplicationPrincipal(pool, {
        issuer: "preflight",
        subject: opts.serviceUserEmail,
        email: opts.serviceUserEmail,
      });
      const orgs = await pool.query(
        `SELECT id, code FROM operating_layer.organizations ORDER BY code`,
      );

      const perOrg: Record<string, Record<string, number>> = {};
      const gaps: string[] = [];
      for (const org of orgs.rows) {
        const counts = await withOrganizationScope(
          pool,
          { userId: principal.userId, organizationIds: [String(org.id)] },
          async (client) => {
            const r = await client.query(
              `SELECT
                 (SELECT count(*) FROM source_systems
                   WHERE organization_id = $1)::int AS sources,
                 (SELECT count(*) FROM approval_policy_versions
                   WHERE organization_id = $1)::int AS policies,
                 (SELECT count(*) FROM audit_streams
                   WHERE organization_id = $1)::int AS streams`,
              [org.id],
            );
            return r.rows[0] as Record<string, number>;
          },
        );
        perOrg[String(org.code)] = counts;
        for (const key of ["sources", "policies", "streams"]) {
          if (Number(counts[key]) === 0) gaps.push(`${org.code}.${key}`);
        }
      }

      return {
        status: gaps.length === 0 ? "pass" : "fail",
        detail:
          gaps.length === 0
            ? `every organization has source systems, approval policies and audit streams`
            : `empty (doorways will fail at intake): ${gaps.join(", ")}`,
        evidence: perOrg,
      };
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Acumatica: the source of truth
// ---------------------------------------------------------------------------

/** The minimum an Acumatica client must expose for these checks. */
export interface AcumaticaProbe {
  login(): Promise<void>;
  logout(): Promise<void>;
  probeEntity(
    entity: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;
  fetchOpenArInvoices(): Promise<
    Array<{
      customerId: string;
      branch: string;
      balance: number;
      dueDate: string | null;
      docType: string;
    }>
  >;
  fetchCustomers(): Promise<
    Map<string, { customerName: string | null; email: string | null }>
  >;
}

/** Fields the Collections doorway depends on, per entity. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  Invoice: [
    "Type",
    "ReferenceNbr",
    "Customer",
    "LinkBranch",
    "DueDate",
    "Balance",
    "Status",
  ],
  Customer: ["CustomerID", "CustomerName", "Status", "MainContact"],
};

export async function checkAcumatica(
  client: AcumaticaProbe,
  opts: {
    /**
     * Leave the session open for the caller to reuse. Acumatica limits
     * concurrent API sessions, so a command that checks AND previews should
     * hold one session rather than opening a second alongside the first.
     */
    keepSessionOpen?: boolean;
  } = {},
): Promise<CheckResult[]> {
  const section = "acumatica";
  const results: CheckResult[] = [];

  const login = await check(section, "authenticates", async () => {
    await client.login();
    return { status: "pass", detail: "login accepted, session established" };
  });
  results.push(login);
  if (login.status === "fail") {
    return [
      ...results,
      {
        section,
        name: "remaining acumatica checks",
        status: "skip",
        detail: "skipped because login failed",
      },
    ];
  }

  try {
    // Field presence, per entity, against the live instance — a wrong $select
    // fails as an opaque 500, so confirm before depending.
    for (const [entity, required] of Object.entries(REQUIRED_FIELDS)) {
      results.push(
        await check(section, `${entity} fields present`, async () => {
          const rows = await client.probeEntity(entity, 1);
          if (rows.length === 0) {
            return {
              status: "warn",
              detail: `no ${entity} records returned; cannot confirm fields`,
            };
          }
          const keys = Object.keys(rows[0]!);
          const missing = required.filter((f) => !keys.includes(f));
          return {
            status: missing.length === 0 ? "pass" : "fail",
            detail:
              missing.length === 0
                ? `all ${required.length} required fields present`
                : `missing: ${missing.join(", ")}`,
            evidence: { fieldCount: keys.length, missing },
          };
        }),
      );
    }

    let invoices: Awaited<ReturnType<AcumaticaProbe["fetchOpenArInvoices"]>> =
      [];
    results.push(
      await check(section, "open AR read", async () => {
        invoices = await client.fetchOpenArInvoices();
        const branches = [...new Set(invoices.map((i) => i.branch))].sort();
        return {
          status: invoices.length > 0 ? "pass" : "warn",
          detail:
            invoices.length > 0
              ? `${invoices.length} open AR documents across branches ${branches.join(", ")}`
              : "no open AR documents returned",
          evidence: { documents: invoices.length, branches },
        };
      }),
    );

    // Credits must come through, or a customer gets chased for a gross figure
    // that ignores money already credited to them.
    results.push(
      await check(section, "credit documents included", async () => {
        const credits = invoices.filter((i) => i.balance < 0);
        return {
          status: credits.length > 0 ? "pass" : "warn",
          detail:
            credits.length > 0
              ? `${credits.length} credit/negative-balance documents present (netting active)`
              : "no negative-balance documents found — either genuinely none outstanding, or the filter is excluding them",
          evidence: { credits: credits.length },
        };
      }),
    );

    results.push(
      await check(section, "customer contacts read", async () => {
        const customers = await client.fetchCustomers();
        const withEmail = [...customers.values()].filter((c) => c.email).length;
        const pct =
          customers.size === 0
            ? 0
            : Math.round((withEmail / customers.size) * 100);
        return {
          // A low rate is not a failure of the wire — it is a data-quality fact
          // the operator needs, because those chases cannot be auto-addressed.
          status: customers.size === 0 ? "fail" : pct >= 50 ? "pass" : "warn",
          detail: `${customers.size} customers, ${withEmail} with a usable AR email (${pct}%)`,
          evidence: { customers: customers.size, withEmail, percent: pct },
        };
      }),
    );
  } finally {
    if (!opts.keepSessionOpen) await client.logout();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pipedrive: deal-status overlay
// ---------------------------------------------------------------------------

export interface PipedriveProbe {
  fetchOpenDeals(): Promise<unknown[]>;
}

export async function checkPipedriveSource(
  sourceName: string,
  client: PipedriveProbe,
  routing: { orgCode?: string; pipelineToOrgCode?: Record<string, string> },
): Promise<CheckResult[]> {
  const section = "pipedrive";
  const results: CheckResult[] = [];

  let deals: unknown[] = [];
  const read = await check(section, `${sourceName}: deal read`, async () => {
    deals = await client.fetchOpenDeals();
    return {
      status: deals.length > 0 ? "pass" : "warn",
      detail:
        deals.length > 0
          ? `${deals.length} open deals`
          : "authenticated but returned no open deals",
      evidence: { deals: deals.length },
    };
  });
  results.push(read);
  if (read.status === "fail") return results;

  // If the account routes by pipeline, every pipeline actually present must be
  // in the map — an unmapped pipeline silently drops those deals.
  if (routing.pipelineToOrgCode) {
    results.push(
      await check(
        section,
        `${sourceName}: pipeline routing covers`,
        async () => {
          const seen = new Map<string, number>();
          for (const deal of deals) {
            const id = String(
              (deal as { pipeline_id?: unknown }).pipeline_id ?? "none",
            );
            seen.set(id, (seen.get(id) ?? 0) + 1);
          }
          const unmapped = [...seen.keys()].filter(
            (id) => !routing.pipelineToOrgCode![id],
          );
          return {
            status: unmapped.length === 0 ? "pass" : "warn",
            detail:
              unmapped.length === 0
                ? `all ${seen.size} pipelines mapped`
                : `unmapped pipeline ids (deals will be skipped): ${unmapped.join(", ")}`,
            evidence: {
              pipelines: Object.fromEntries(seen),
              unmapped,
            },
          };
        },
      ),
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Outbound mail: the draft output channel
// ---------------------------------------------------------------------------

/**
 * The mail wire is what turns an approved chase into a draft sitting in the
 * entity's AR mailbox. The group runs on Outlook / Microsoft 365, and no
 * Outlook connector exists yet — so this reports the gap explicitly rather
 * than silently passing.
 */
export function checkMailWire(
  env: Record<string, string | undefined>,
): CheckResult[] {
  const section = "mail";
  const configured = Boolean(env.OUTLOOK_DRAFT_ENABLED === "true");
  return [
    {
      section,
      name: "outlook draft wire",
      status: configured ? "warn" : "skip",
      detail: configured
        ? "OUTLOOK_DRAFT_ENABLED is set but no Outlook connector is implemented yet"
        : "not implemented — approved chases carry composed text, but nothing deposits it in a mailbox yet",
      evidence: { implemented: false, provider: "microsoft-365" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ICON: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

/** Human-readable report. Stable, greppable, safe to paste into a terminal. */
export function renderReport(report: PreflightReport): string {
  const lines: string[] = [];
  let currentSection = "";
  for (const r of report.results) {
    if (r.section !== currentSection) {
      currentSection = r.section;
      lines.push("", `── ${currentSection.toUpperCase()} ──`);
    }
    lines.push(`  ${ICON[r.status]}  ${r.name}`);
    lines.push(`        ${r.detail}`);
  }
  lines.push(
    "",
    `${report.passed} passed · ${report.failed} failed · ${report.warned} warnings · ${report.skipped} skipped`,
    report.ok
      ? "No failures. Warnings above are facts to act on, not blockers."
      : "FAILURES PRESENT — do not enable a doorway until these are green.",
  );
  return lines.join("\n");
}
