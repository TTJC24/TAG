# KPI Spec

## v1 KPI Set

This file defines the initial v1 metrics for the scoreboard. Each KPI must remain explicit, versioned, and testable.

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
  - included/excluded stages must be defined in implementation
  - pipeline is not revenue truth

---

## 6. Stale Opportunities

- Domain: Sales
- Source of truth: Pipedrive
- Description: Opportunities lacking required follow-up cadence or aging in stage beyond threshold
- Refresh model: near-real-time
- Required output:
  - opportunity
  - owner
  - stage
  - days stale
  - next activity due
  - freshness timestamp
- Notes:
  - stale threshold must be defined explicitly in code/config
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
- Required output:
  - order number
  - customer
  - owner if available
  - status
  - days stalled
  - freshness timestamp
- Notes:
  - exact stuck-order criteria must be defined explicitly
  - this is an exception queue KPI, not just a count

---

## 9. Dead Stock Moved

- Domain: Sales / Inventory
- Source of truth: Acumatica
- Description: Movement of items classified as dead stock under approved business rule
- Refresh model: daily or near-real-time depending on implementation
- Required output:
  - rep if attributable
  - item
  - quantity moved
  - value moved
  - period
  - freshness timestamp
- Notes:
  - dead stock classification rule must be explicitly defined
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
