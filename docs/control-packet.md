# Control Packet

## Objective

Build a live, read-only operating scoreboard that integrates Acumatica and Pipedrive and presents certified KPI visibility for leadership and frontline management.

The scoreboard must provide useful live operational visibility without compromising financial truth, ERP integrity, or auditability.

## v1 Scope

v1 includes:

- leadership flash view
- sales scoreboard
- Acumatica integration
- Pipedrive integration
- live operational exception widgets
- certified KPI logic
- timestamps and freshness states
- reconciliation and fail-state handling

v1 excludes:

- writeback into source systems
- generalized AI assistant behavior
- automated enforcement actions
- broad document ingestion
- uncontrolled custom KPI sprawl
- replacing Acumatica or Pipedrive workflows

## Locked v1 Business Rules

The following rules are locked for v1 and must be implemented exactly as stated:

- Entities in scope: `FS` and `BL`
- Pipedrive owners in scope: all salespeople
- Activity standard: `8` qualifying touches per workday for all salespeople
- Qualifying activity types:
  - face-to-face meeting
  - jobsite visit
  - other meeting
- Open pipeline scope: all active non-won/non-lost Pipedrive stages
- Financial cutoff: prior closed day at `11:59:59 PM` ET
- Stale opportunity rule: no qualifying activity in `7` days OR same stage for `14+` days
- Stuck order rule: open sales order with no status movement/shipment/progress event for `2+` days, excluding canceled/completed
- Dead stock rule: on hand `> 90` days and no sales in `90` days

## Governed Mapping Lock (Approved)

The following production mappings are governed for v1 and are no longer provisional:

- `ACUMATICA_BRANCH_CODES=FS,BL`
- `BRANCH_ENTITY_MAPPING_JSON={"FS":"FS","BL":"BL"}`
- `REP_MAPPING_JSON` approved rep list
- `ACTIVITY_TYPE_INCLUDE_NAMES=Face-to-face meeting,Jobsite visit,Other meeting`

Operational requirement:
- Surface unmapped branches and reps explicitly as exceptions.
- Do not silently fall back to raw names for governed outputs.
- Financial KPI certification still requires extraction and tie-out implementation.

## Source-of-Truth Hierarchy

### Acumatica
Authoritative for:
- invoiced revenue
- cost and margin
- sales orders
- inventory availability
- purchasing
- shipments
- open operational order states

### Pipedrive
Authoritative for:
- rep activities
- meetings
- touch counts
- pipeline values
- opportunity stages
- next activity due
- stale opportunity tracking

### SharePoint / Cortex
Deferred to later phases for:
- policy context
- SOP context
- governed document explanation
- exception narrative support

## Read-Only Rule

The scoreboard is read-only in v1.

No writeback.
No operational mutations.
No approvals from this app.
No transaction entry from this app.

## Live Model

The scoreboard uses a hybrid freshness model.

### Near-real-time operational metrics
Refresh target: every 5 to 15 minutes

Includes:
- sales activities
- pipeline
- open orders
- holds
- shipments
- PO status
- operational exceptions

### Certified financial metrics
Refresh target: daily closed cutoff

Includes:
- invoiced revenue
- gross profit
- gross margin
- rep financial rollups

Financial metrics should not present pseudo-real-time values if certification rules require closed-cutoff logic.

## Failure-State Rule

If a source pull fails, mapping fails, or reconciliation fails:
- surface error state
- retain last-good timestamp if available
- do not fabricate current values
- do not silently fall back to weaker logic in production

## Data Model Requirements

A normalization layer is required between source systems and UI.

Core shared dimensions should include:
- date
- entity
- branch
- rep
- customer
- item
- department
- owner

The UI must consume normalized KPI outputs, not raw source joins.

## Initial Pages

### Leadership Flash
Must show:
- core KPI status
- trend vs target
- freshness
- top exceptions
- owner visibility

### Sales Scoreboard
Must show by rep:
- revenue MTD
- margin %
- activities
- activity vs standard
- pipeline
- stale opportunities
- dead stock moved where available

### Exception Widgets
Initial exception widgets:
- stuck orders
- stale opportunities
- dead stock moved

## Certification Discipline

Every KPI must have:
- explicit definition
- explicit source system
- explicit refresh cadence
- explicit target logic where relevant
- explicit fail-state behavior

No KPI may be marked production-ready without a documented definition in `docs/kpi-spec.md`.

## Delivery Standard

The first usable release is not “all departments.”

The first usable release is:
- leadership can review it
- numbers are grounded
- failures are visible
- operators trust it enough to use daily
