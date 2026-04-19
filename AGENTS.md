# AGENTS.md

## Mission

Build a read-only live scoreboard that integrates Acumatica and Pipedrive without breaking source-of-truth discipline, accounting integrity, or auditability.

## Hard Rules

1. Acumatica is the source of truth for:
   - invoiced revenue
   - cost
   - gross profit
   - gross margin
   - sales orders
   - inventory
   - purchasing
   - shipment / fulfillment status

2. Pipedrive is the source of truth for:
   - sales activities
   - meetings
   - touches
   - opportunity pipeline
   - deal stage
   - next activity due
   - stale deal follow-up

3. Pipedrive must never be used as financial truth.

4. The scoreboard is read-only in v1.
   - no source writeback
   - no mutations into Acumatica
   - no mutations into Pipedrive

5. Financial KPI logic must be certified.
   - if tie-out or source validation fails, return FAIL
   - do not fabricate fallback values
   - do not silently degrade logic

6. Every KPI must expose:
   - value
   - source system
   - as-of timestamp
   - freshness state
   - certification state

7. Do not infer business logic that is not explicitly defined in docs/control-packet.md or docs/kpi-spec.md.

8. No mock data in production code paths.

## Implementation Standards

- Prefer explicit, boring, testable code
- Favor deterministic transformations over clever abstractions
- Keep connectors isolated by source system
- Separate raw ingestion, normalization, KPI computation, and presentation layers
- Expose clear error states
- Log source pull failures and reconciliation failures explicitly
- Use typed schemas where possible
- Build with replay/debuggability in mind

## Architecture Expectations

The codebase should separate concerns as follows:

- `backend/connectors/`
  - Acumatica client
  - Pipedrive client

- `backend/ingestion/`
  - scheduled pulls
  - raw landing models

- `backend/normalization/`
  - dimensions
  - canonical mappings
  - entity / rep / branch alignment

- `backend/kpis/`
  - KPI definitions
  - target logic
  - variance logic
  - fail-state logic

- `backend/api/`
  - read-only endpoints for the frontend

- `frontend/`
  - leadership flash
  - sales scoreboard
  - exception views

- `tests/`
  - connector tests
  - transformation tests
  - KPI math tests
  - fail-state tests

## UI Standards

The UI should be operational, not decorative.

Requirements:
- show exceptions clearly
- show stale data clearly
- show FAIL states clearly
- show source and timestamp
- keep leadership view simple and high-signal
- default to tables and compact status cards over noisy charts
- avoid clutter

## Initial v1 Deliverables

1. leadership flash page
2. sales scoreboard page
3. Acumatica connector
4. Pipedrive connector
5. KPI engine for v1 metrics
6. exception widgets for:
   - stuck orders
   - stale opportunities
   - dead stock moved
7. certification / freshness indicators
8. test coverage for KPI calculations and source failure states

## Prohibited Patterns

- No direct frontend calls to source systems
- No financial logic embedded only in frontend code
- No hidden fallback mappings
- No production metric without timestamp
- No blending of asynchronous source updates without documented rules
- No writeback features in v1
