# Company Brain Live Readiness Ledger

This ledger records the evidence required before Company Brain can be treated as live-production ready for configured source freshness, API smoke, and downstream product consumption.

## Current Status

- live readiness status: blocked
- safe configured environment: missing
- `bun run smoke`: local fixture-mode smoke passes
- `bun run smoke:api`: local fixture-mode API smoke passes
- live source freshness check: missing
- bounded live-read proof: missing
- production API token/deployment proof: missing
- downstream consumer smoke: missing

## What Is Proven Today

The current CI/local baseline proves fixture and contract behavior:

- fixture import validation,
- connector provenance validation,
- connector health/freshness classification,
- citation metadata evaluation,
- answer behavior evaluation,
- local fixture-mode smoke and API smoke,
- TypeScript typecheck.

This is not the same as proving live source freshness or production API readiness.

## Required Evidence Before Live Promotion

| Evidence item | Required proof | Current state |
| --- | --- | --- |
| safe configured environment | non-production or approved production-like env with real-shaped credentials and no destructive writes | missing |
| live connector status | `/connectors/status` or CLI output showing expected connectors as `live_ready` | missing |
| live source freshness | source freshness reviewed for fresh/recent/stale/unknown states against configured systems | missing |
| bounded live reads | Pipedrive, M365, Acumatica, and other live connectors use capped/read-only requests | missing |
| sanitized failure states | auth/rate-limit/source-unavailable failures expose sanitized env-name/status details only | missing |
| API smoke | `bun run smoke:api` against the intended API URL/token | local fixture-mode smoke passes; safe-env deployed API smoke missing |
| local/domain smoke | `bun run smoke` in the intended safe env | local fixture-mode smoke passes; safe-env smoke missing |
| downstream consumer | TractionOS or another approved consumer reads Company Brain health without leaking private data | missing |
| rollback plan | rollback or disable plan for live connector/API promotion | missing |

## Allowed Claims Until Complete

Allowed:

- fixture-backed knowledge/retrieval service,
- provenance-checked connector pipeline,
- source-health classification contract,
- citation and answer evaluation baseline,
- API contract ready for safe-env smoke.
- local fixture-mode smoke/API smoke baseline.

Blocked:

- blocked until evidence: live production-ready source freshness,
- blocked until evidence: fully configured live Company Brain,
- blocked until evidence: downstream product dependency on live Company Brain data,
- blocked until evidence: public or customer-facing knowledge API,
- blocked until evidence: claims that stale or failed live sources are current.

## Decision Rule

Do not promote live Company Brain or wire downstream products to live source data until the required evidence table is complete.

If live evidence is missing, use fixture-backed checks and clearly label live source status as unverified.
