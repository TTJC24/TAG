# Current Repository Assessment

Date: 2026-07-25

## Initial inspection result

The handoff started as an empty, non-Git directory with no repository-specific
instructions, credentials, schemas, or implementation to preserve. It is now
a Git repository with a pull-request verification workflow.

## Current capability

The repository now has a runnable Phase 1 intake slice plus Phase 2 internal
approval resolution, deterministic internal execution, and controlled CSV
batch intake plus one disabled-by-default Gmail draft capability:

- modular TypeScript workspace with Next.js web, Fastify API, and worker;
- PostgreSQL 16 schema, Phase 1 control migration, and deterministic local seed;
- provider-neutral development/OIDC identity adapters;
- organization-scoped application transactions plus database row-level security;
- append-only raw source versions and independently verified, hash-chained
  audit history;
- versioned seven-day idempotency retention, prior-result replay, and a bounded
  PostgreSQL reaper that serializes with replay;
- deterministic, schema-validated classification and recommendation agents;
- database-enforced workflow transitions, guarded task-status projection, and
  immutable organization-scoped declarative approval policy;
- two-person activation for new policy versions and single-actor break-glass
  restoration of an already approved version;
- authorized, idempotent internal approve/reject resolution; approval stops at
  the executable `approved` state and rejection is terminal;
- a provider-neutral execution seam with `deterministic_internal` as the
  default and a Gmail `drafts.create` provider gated by approved task, enabled
  organization config, recipient allowlist, exact preview, second
  authorization, and worker network flag;
- database-enforced internal and external-draft transitions, guarded
  kill-switch fallback to `approved`, bounded retries, and execution
  dead-letter visibility;
- internal CSV file upload with immutable raw bytes/provenance, typed per-row
  validation, partial success, batch/row idempotency, source-linked tasks, and
  bounded downstream failure projection;
- boot-time rejection of RLS-bypassing API/worker database identities;
- executive queue and task detail/history screens;
- unit and clean-database integration tests.

There is no enabled production source-system integration. The sole external
write implementation creates an unsent Gmail draft and ships inert; sending
and every other external mutation are absent.

## Immediate implications

1. Keep `operating-layer` as a neutral codename until branding is approved.
2. Treat connector schemas, scopes, and credentials as unresolved.
3. Keep every future connector capability separately reviewed; Gmail remains
   `drafts.create` only and disabled until production enablement review.
4. Preserve PostgreSQL as the operating-layer authority; Redis is ephemeral only.
5. Resolve hosting, OIDC client configuration, production database identities,
   exact business roles, and the broader data-retention schedule before
   production deployment.
6. Do not add Gmail sending or another external write during this handoff.

## Existing assets

Seed organizations, identities, source systems, prompts, and all deterministic
agent behavior are synthetic and local-only.

## Handoff boundary

The implementation stops at the passing Gmail draft external-write slice.
Scheduled ingestion, production enablement, live models, external sends, and
other source-system writes require a new review.

## Local tooling note

Docker Desktop and pnpm are installed. A general `node` executable was not
available on the original shell `PATH`; validation used the isolated Codex
Node runtime. Install or expose Node.js 22 LTS before using the normal commands
outside Codex.
