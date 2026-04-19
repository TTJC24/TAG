# KPI Spec

## v1 KPI Set

This file defines the initial v1 metrics for the scoreboard. Each KPI must remain explicit, versioned, and testable.

## Global v1 Rule Locks

These rule locks apply across the KPI set unless explicitly superseded by a future versioned spec update.

- Entities in v1 scope: `FS`, `BL`
- Pipedrive owner scope: all salespeople
- Qualifying activity types:
  - face-to-face meeting
  - jobsite visit
  - other meeting
- Activity standard: `8` qualifying touches per workday for all salespeople
- Open pipeline scope: all active non-won/non-lost stages
- Financial cutoff: prior closed day at `11:59:59 PM` ET
- Stale opportunity threshold: no qualifying activity in `7` days OR unchanged stage for `14+` days
- Stuck order threshold: no status movement/shipment/progress event for `2+` days (exclude canceled/completed)
- Dead stock definition: on hand `> 90` days and no sales in `90` days

### Governed Mapping Note

Governed production mappings are locked as:
- `ACUMATICA_BRANCH_CODES=FS,BL`
- `BRANCH_ENTITY_MAPPING_JSON={"FS":"FS","BL":"BL"}`
- Approved governed `REP_MAPPING_JSON`
- `ACTIVITY_TYPE_INCLUDE_NAMES=Face-to-face meeting,Jobsite visit,Other meeting`

Any unmapped branch or rep must be surfaced as an explicit exception state.

### Certified Financial v1 Production Lock

- `ACUMATICA_AR_INVOICES_PATH=/entity/Default/22.200.001/ARInvoice`
- `ACUMATICA_FINANCIAL_DATE_FIELD=invoice_date`
- `ACUMATICA_FINANCIAL_BRANCH_FIELD=branch`
- `ACUMATICA_FINANCIAL_REP_FIELD=rep`
- `ACUMATICA_FINANCIAL_REVENUE_FIELD=revenue`
- `ACUMATICA_FINANCIAL_COST_FIELD=cost`
- `ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD=gross_profit`
- Certified grain: `acumatica_ar_invoice_line` (`invoice_ref` + `line_nbr`)
- Rep attribution: line-level rep required, no fallback inference
- Signed amount policy:
  - invoice / debit memo => positive signed amounts
  - credit memo / return => negative signed amounts
  - void / voided => excluded from certified totals
- Out-of-scope branch rows are hard-fail blockers for certification.

---

## 1. Invoiced Revenue MTD by Rep

- Domain: Sales
- Source of truth: Acumatica
- Description: Month-to-date invoiced revenue attributed to each rep
- Refresh model: certified daily cutoff
- Grain: invoice line or approved certified grain
- Required output:
  - rep
  - MTD revenue
  - as-of date
  - certification status
- Notes:
  - final attribution rules to be locked before production
  - must not use Pipedrive data
  - must fail clearly if certification logic fails

---

## 2. Gross Margin % MTD by Rep

- Domain: Sales
- Source of truth: Acumatica
- Description: Month-to-date gross margin percentage by rep
- Refresh model: certified daily cutoff
- Required output:
  - rep
  - revenue
  - cost
  - gross profit
  - gross margin %
  - as-of date
  - certification status
- Notes:
  - must be tied to certified Acumatica logic
  - no fallback to estimated CRM values

---

## 3. Activity Count by Rep

- Domain: Sales
- Source of truth: Pipedrive
- Description: Count of qualifying rep activities in current period
- Refresh model: near-real-time
- Qualifying activities for v1:
  - face-to-face meeting
  - jobsite visit
  - other meeting
- Required output:
  - rep
  - raw count
  - period
  - freshness timestamp
- Notes:
  - activity taxonomy must match actual Pipedrive configuration

---

## 4. Activity vs Standard by Rep

- Domain: Sales
- Source of truth: Pipedrive
- Description: Comparison of actual qualifying activity count against target standard
- Refresh model: near-real-time
- Initial target assumption:
  - 8 touches per working day
- Required output:
  - rep
  - actual count
  - target count
  - delta
  - delta %
  - freshness timestamp
- Notes:
  - working-day logic must be explicit
  - standard may later vary by role/entity

---

## 5. Open Pipeline by Rep

- Domain: Sales
- Source of truth: Pipedrive
- Description: Active opportunity value by rep based on included stages
- Refresh model: near-real-time
- Required output:
  - rep
  - total open pipeline
  - stage breakdown if available
  - freshness timestamp
- Notes:
  - included stages are all active non-won/non-lost stages
  - pipeline is not revenue truth

---

## 6. Stale Opportunities

- Domain: Sales
- Source of truth: Pipedrive
- Description: Opportunities lacking required follow-up cadence or aging in stage beyond threshold
- Refresh model: near-real-time
- Rule lock:
  - stale if no qualifying activity in 7 days OR same stage for 14+ days
- Required output:
  - opportunity
  - owner
  - stage
  - days stale
  - next activity due
  - freshness timestamp
- Notes:
  - should power exception widget

---

## 7. Open Order Backlog

- Domain: Operations
- Source of truth: Acumatica
- Description: Open sales order backlog requiring operational visibility
- Refresh model: near-real-time
- Required output:
  - count
  - value
  - branch/entity breakdown where applicable
  - freshness timestamp

---

## 8. Stuck Orders

- Domain: Operations / Customer Service
- Source of truth: Acumatica
- Description: Orders on hold, stalled, or aged beyond expected movement thresholds
- Refresh model: near-real-time
- Rule lock:
  - open sales order with no status movement/shipment/progress event for 2+ days
  - exclude canceled/completed orders
- Required output:
  - order number
  - customer
  - owner if available
  - status
  - days stalled
  - freshness timestamp
- Notes:
  - this is an exception queue KPI, not just a count

---

## 9. Dead Stock Moved

- Domain: Sales / Inventory
- Source of truth: Acumatica
- Description: Movement of items classified as dead stock under approved business rule
- Refresh model: daily or near-real-time depending on implementation
- Rule lock:
  - dead stock = on hand > 90 days and no sales in 90 days
- Required output:
  - rep if attributable
  - item
  - quantity moved
  - value moved
  - period
  - freshness timestamp
- Notes:
  - this metric is intended to support scoreboarding and reduction efforts

---

## 10. Freshness Status

- Domain: Platform
- Source of truth: system-generated
- Description: Freshness state of each widget/KPI based on expected source refresh window
- Required output:
  - source system
  - last successful pull
  - expected refresh interval
  - freshness status:
    - fresh
    - delayed
    - stale
    - failed

---

## 11. Certification Status

- Domain: Platform
- Source of truth: system-generated based on validation checks
- Description: Whether KPI is certified, provisional, stale, or failed
- Required output:
  - KPI name
  - status
  - validation notes if failed
- Allowed statuses:
  - certified
  - provisional
  - stale
  - failed
  - FAIL
