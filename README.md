# Scoreboard

Read-only operations scoreboard scaffold for Acumatica and Pipedrive KPI logic, certification candidates, and exception monitoring.

Promotion note: this repo is a KPI/control-spec feeder for TractionOS. Do not treat it as a standalone live production dashboard or certified financial system until `docs/tractionos-promotion-evidence-ledger.md` records production mappings, validation artifacts, freshness evidence, read-only/no-writeback proof, and owner approval.

## Purpose

This repository contains the source code, control definitions, and implementation rules for a read-only operating scoreboard used to monitor sales, operations, customer service, procurement, warehouse, and leadership KPIs.

The scoreboard is built on a strict source-of-truth model:

- Acumatica = financial, order, inventory, and procurement truth
- Pipedrive = sales activity and pipeline truth
- SharePoint/Cortex = governed document and policy context later
- Scoreboard app = read-only presentation, KPI computation, and exception visibility

## v1 Scope

Initial v1 scope is intentionally narrow:

- leadership flash view
- sales scoreboard
- live operational exception widgets
- Acumatica integration
- Pipedrive integration
- certified KPI definitions
- explicit fail states
- freshness timestamps
- no writeback to source systems

## Non-Goals

The following are explicitly out of scope for v1:

- writeback into Acumatica
- writeback into Pipedrive
- broad AI assistant behavior
- generic enterprise search
- automated enforcement actions
- replacing ERP or CRM
- unofficial or inferred financial logic

## Operating Rules

- Financial truth must tie to Acumatica control logic
- Pipedrive may not be used as revenue truth
- Any failed reconciliation must surface as FAIL, not a fabricated value
- All KPI logic must be explicit and versioned
- No silent fallback logic in production
- No mock data in production
- All production metrics must carry freshness metadata

## Initial Repository Structure

- `docs/control-packet.md` — business rules, source hierarchy, and scope
- `docs/kpi-spec.md` — KPI-by-KPI definitions
- `AGENTS.md` — implementation rules for Codex and contributors
- `backend/` — connectors, ETL, KPI engine, API
- `frontend/` — scoreboard UI
- `tests/` — validation and reconciliation tests

## Build Sequence

1. Lock control packet
2. Lock KPI spec
3. Build read-only connectors
4. Normalize source data
5. Build certified KPI engine
6. Build leadership and sales views
7. Add exception widgets
8. Validate against real source data before production
