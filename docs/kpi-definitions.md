# KPI Definitions

Pulled verbatim from the Appendix sheet of `reference/TRACTION_MEETING_TEMPLATE.xlsx`. This is the source of truth for measurable formulas. Goal directions are normalized to the `goalDirection` enum (`gte | lte | eq | between | trend_down | trend_up`) used in the Drizzle schema; the human-readable target in the Appendix is preserved alongside.

When a measurable references "Revenue", "COGS", "AR", "AP", or "Inventory" without further qualifier, it means the value for the **entity that owns the row** (FS, BL, or USA). Each measurable belongs to exactly one entity — there is no consolidated / "ALL" scope (see ADR-0009).

---

## Appendix — KPI Definitions (verbatim)

| KPI | Formula / Definition | Target | Frequency | Owner (per seed scorecard) |
|---|---|---|---|---|
| Revenue (Weekly) | Net sales per entity per week | Per budget | Weekly | Daniel (FS), Nick (BL), Andrew (USA) |
| Gross Profit % | GP% = (Revenue – (COGS + Freight Burden)) / Revenue | FS: 50%, BL: 30%, USA: 15% | Weekly | Daniel (FS), Nick (BL), Andrew (USA) |
| Freight Factor | FS: 8% of COGS \| BL: 5% of COGS | Per entity | Monthly | — (input to GP% calc, not a standalone Scorecard row) |
| DSO | AR / (Revenue / 365) | ≤45 days | Weekly | Tim |
| DPO | AP / (COGS / 365) | ≥30 days | Weekly | Tim |
| DIO | Inventory / (COGS / 365) | ≤60 days | Weekly | Craig |
| Inventory Turns | COGS / Avg Inventory | ≥6x | Monthly | Craig |
| Fill Rate % | Lines Shipped Complete / Total Lines Ordered | ≥95% | Weekly | Tom (FS), Chris B (BL) |
| AR Collections ($) | Cash collected on AR for the week | Per forecast | Weekly | Tim |
| GP per Labor $ (dLER) | Gross Profit / Total Direct Labor Cost | ≥$2.50 | Monthly | — (not in v1 seed scorecard) |
| Cash Conversion Cycle | DSO + DIO – DPO | ≤75 days | Monthly | — (derived; surface on dashboards, not Scorecard) |
| Open Orders (Backlog) | Total open SO value | Declining trend | Weekly | Chip |

The Appendix did not define formulas for these v1 Scorecard rows; the kickoff specifies them. Treat the kickoff as the source for these.

| KPI (kickoff only) | Definition | Target | Frequency | Owner |
|---|---|---|---|---|
| New Accounts Opened | Count of new customer accounts opened in the week, per entity | 1 / week | Weekly | Daniel (FS), Nick (BL) |
| On-Time Deliveries | Deliveries on or before promise date / total deliveries | ≥85% | Weekly | Chip (FS, BL) |

---

## `goalDirection` normalization

The Excel template encodes direction inside the target string (`≤45`, `≥30`, `1 PER WEEK`). The DB stores direction in a typed enum and the target as a number, so variance math is unambiguous.

| Appendix target | `goalDirection` | `goalValue` | Notes |
|---|---|---|---|
| Per budget | `gte` | budget value | Per-entity budget passed in from the entity row |
| FS: 50%, BL: 30%, USA: 15% | `gte` | 0.50 / 0.30 / 0.15 | Stored as decimal (`0.50`), never percent (`50`). The Excel sheet mixes both — we don't. |
| ≤45 days | `lte` | 45 | |
| ≥30 days | `gte` | 30 | |
| ≤60 days | `lte` | 60 | |
| ≥6x | `gte` | 6 | |
| ≥95% | `gte` | 0.95 | |
| Per forecast | `gte` | weekly forecast value | |
| ≥$2.50 | `gte` | 2.50 | |
| ≤75 days | `lte` | 75 | |
| Declining trend | `trend_down` | (null) | Status reads slope of last 4 weeks. |
| 1 / week | `gte` | 1 | |
| ≥85% | `gte` | 0.85 | |

---

## Storage conventions

- **Percentages are decimals.** `0.50`, never `50`. UI formats with `Intl.NumberFormat(..., { style: 'percent' })`.
- **Currency is integer cents** in the column, formatted on display. (Avoids floating-point noise on totals.)
- **Days** are integers; **turns** is a decimal with one fractional digit.
- `formula` on the `measurables` row is a human-readable string (the Formula/Definition column above), shown in tooltips. It is not parsed or executed.
- `formatHint` on the `measurables` row picks the display formatter: `currency_usd | percent | days | turns | count | currency_usd_trend`.

---

## Per-entity replication (seed scorecard)

The kickoff lists six KPIs at an "ALL" scope (DSO, DPO, DIO, Inventory Turns, AR Collections, Open Orders Backlog). Under the per-entity model these become **three rows each — one per org** — owned by the same person across all three. Tim is admin in all three Clerk orgs, so his accounting KPIs (DSO, DPO, AR Collections) live on each entity's Scorecard and are computed against that entity's AR / AP / revenue. Same pattern for Craig (DIO, Inventory Turns) and Chip (Open Orders Backlog).

Per-entity seed (v1):

| Org | Measurables on its Scorecard |
|---|---|
| FS | Revenue (Daniel), Gross Profit % (Daniel), DSO (Tim), DPO (Tim), DIO (Craig), Inventory Turns (Craig), Fill Rate % (Tom), AR Collections $ (Tim), Open Orders Backlog (Chip), New Accounts Opened (Daniel), On-Time Deliveries (Chip) |
| BL | Revenue (Nick), Gross Profit % (Nick), DSO (Tim), DPO (Tim), DIO (Craig), Inventory Turns (Craig), Fill Rate % (Chris B), AR Collections $ (Tim), Open Orders Backlog (Chip), New Accounts Opened (Nick), On-Time Deliveries (Chip) |
| USA | Revenue (Andrew), Gross Profit % (Andrew), DSO (Tim), DPO (Tim), DIO (Craig), Inventory Turns (Craig), AR Collections $ (Tim), Open Orders Backlog (Chip) |

Targets carry from the kickoff per entity. The kickoff's $250k AR Collections target was a consolidated number; per-entity targets are TBD — seed all three with $250k as a placeholder and flag for Tim to revise once real per-entity figures are in hand. USA does not seed Fill Rate, On-Time Deliveries, or New Accounts — no owner is assigned in the kickoff. The team can add them later via `/add-measurable`.

---

## Inputs sourced from accounting / ops

Several formulas above depend on inputs that don't live in this app yet. They will be entered manually in v1 (the owner types the result of their own calc into the Scorecard). When we wire Acumatica in a later phase, we'll pull the inputs and derive these.

| Derived measurable | Inputs needed |
|---|---|
| Gross Profit % | Revenue, COGS, Freight Burden (Freight Factor × COGS) |
| DSO | AR balance, trailing-365 Revenue |
| DPO | AP balance, trailing-365 COGS |
| DIO | Inventory balance, trailing-365 COGS |
| Inventory Turns | trailing COGS, Avg Inventory |
| Fill Rate % | Lines Shipped Complete, Total Lines Ordered |
| GP per Labor $ | Gross Profit, Total Direct Labor Cost |
| Cash Conversion Cycle | DSO, DIO, DPO (derived) |
