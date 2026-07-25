# Current Repository Assessment

Date: 2026-07-25

## Initial inspection result

The handoff started as an empty, non-Git directory with no repository-specific
instructions, credentials, schemas, or implementation to preserve. It remains
a local working directory rather than a Git repository.

## Current capability

The repository now has a runnable Phase 1 manual-intake vertical slice:

- modular TypeScript workspace with Next.js web, Fastify API, and worker;
- PostgreSQL 16 schema, Phase 1 control migration, and deterministic local seed;
- provider-neutral development/OIDC identity adapters;
- organization-scoped application transactions plus database row-level security;
- append-only raw source versions and hash-chained audit history;
- idempotent issue intake and PostgreSQL-authoritative outbox retries;
- deterministic, schema-validated classification and recommendation agents;
- database-enforced workflow transitions and code-based approval policy;
- executive queue and task detail/history screens;
- unit and clean-database integration tests.

There is no production source-system integration or external write capability.

## Immediate implications

1. Keep `operating-layer` as a neutral codename until branding is approved.
2. Treat connector schemas, scopes, and credentials as unresolved.
3. Keep every future connector read-only until separately reviewed.
4. Preserve PostgreSQL as the operating-layer authority; Redis is ephemeral only.
5. Resolve retention, hosting, OIDC client configuration, production database
   identities, and exact business roles before production deployment.
6. Do not implement external writes during this handoff.

## Existing assets

Seed organizations, identities, source systems, prompts, and all deterministic
agent behavior are synthetic and local-only.

## Handoff boundary

The implementation stops at the passing manual-intake slice. CSV import,
production connectors, live model providers, external sends, and source-system
writes require a new review.

## Local tooling note

Docker Desktop and pnpm are installed. A general `node` executable was not
available on the original shell `PATH`; validation used the isolated Codex
Node runtime. Install or expose Node.js 22 LTS before using the normal commands
outside Codex.
