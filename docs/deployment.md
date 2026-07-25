# Deployment Outline

This is a deployment design, not a production environment decision.

## Runtime components

- Next.js web application, optionally on Vercel.
- API service and worker service on a container platform.
- Managed PostgreSQL 16+.
- Managed Redis for dispatch/cache.
- S3-compatible encrypted object storage.
- Managed secrets and an OIDC configuration.
- Central logs, traces, metrics, and alerting.

## Environment separation

Use separate accounts/projects, databases, buckets, Redis namespaces, OIDC clients, connector credentials, and encryption keys for local, staging, and production. Never copy production raw payloads into lower environments.

## Required production inputs

- hosting provider, region, domains, and network policy;
- recovery point/recovery time objectives;
- Google Workspace domain/client/group mapping;
- database, Redis, and object-storage providers;
- secret manager and key-management policy;
- approved model provider routes and budgets;
- observability vendor and incident routing;
- retention, backup, and audit-export policy.

## Deployment order

1. Provision private data services and secrets.
2. Run reviewed forward-only migrations using a dedicated migration identity.
3. Deploy API with worker consumption disabled.
4. Run health, permission, and migration checks.
5. Deploy workers with source writes structurally disabled.
6. Deploy the web application.
7. Enable only approved read/import workflows.
8. Run smoke tests and confirm audit/telemetry delivery.

Rollback reverts application versions. Database migrations require explicit forward-fix or a separately reviewed reversible migration; destructive automatic rollback is not allowed.

## Local development

The local stack uses Docker Compose for PostgreSQL 16, Redis, and
S3-compatible object storage. Copy `.env.example` to an untracked `.env` and
use only local development values. Run the web, API, and worker as separate
processes as documented in the repository README.

`pnpm test:feature` uses `compose.test.yaml` and a uniquely named disposable
volume. It validates migrations and seed data against a clean PostgreSQL 16
instance and removes the instance afterward.

Production hosting remains undecided. Before a deployment decision, define
separate non-owner migration, API, worker, and reporting database identities;
managed secret references; backup/restore objectives; retention rules; OIDC
client configuration; and immutable audit export.
