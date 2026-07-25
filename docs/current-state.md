# Current Repository Assessment

Date: 2026-07-25

## Initial inspection result

The handoff started as an empty, non-Git directory with no repository-specific
instructions, credentials, schemas, or implementation to preserve. It is now
a Git repository with a pull-request verification workflow.

## Current capability

The repository now has a runnable Phase 1 intake slice plus Phase 2 internal
approval resolution and deterministic internal execution:

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
- a provider-neutral execution seam with only
  `deterministic_internal` enabled, immutable execution command/results, and
  no external effect;
- database-enforced `approved -> executing -> completed|execution_failed`
  transitions, bounded retries, and execution dead-letter visibility;
- boot-time rejection of RLS-bypassing API/worker database identities;
- executive queue and task detail/history screens;
- unit and clean-database integration tests.

There is no production source-system integration or external write capability.

## Immediate implications

1. Keep `operating-layer` as a neutral codename until branding is approved.
2. Treat connector schemas, scopes, and credentials as unresolved.
3. Keep every future connector read-only until separately reviewed.
4. Preserve PostgreSQL as the operating-layer authority; Redis is ephemeral only.
5. Resolve hosting, OIDC client configuration, production database identities,
   exact business roles, and the broader data-retention schedule before
   production deployment.
6. Do not implement external writes during this handoff.

## Existing assets

Seed organizations, identities, source systems, prompts, and all deterministic
agent behavior are synthetic and local-only.

## Handoff boundary

The implementation stops at the passing deterministic internal-execution
slice. CSV import, production connectors, live model/execution providers,
external sends, and source-system writes require a new review.

## Local tooling note

Docker Desktop and pnpm are installed. A general `node` executable was not
available on the original shell `PATH`; validation used the isolated Codex
Node runtime. Install or expose Node.js 22 LTS before using the normal commands
outside Codex.
