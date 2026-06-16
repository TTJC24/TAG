# TractionOS Feeder Contract

`scoreboard` is a requirements feeder for `tractionos`, not a separate product to scale independently by default.

## Role

This repo owns the certified KPI/control packet until those definitions are stable enough to implement in TractionOS.

TractionOS should consume:

- KPI definitions from `docs/kpi-spec.md`,
- source-of-truth hierarchy from `docs/control-packet.md`,
- freshness and certification state rules,
- exception definitions for stale opportunities, stuck orders, and dead stock moved,
- Acumatica/Pipedrive boundary rules,
- read-only/no-writeback discipline for v1.

## Do Not Move Yet

Do not port anything into TractionOS until each item has:

- explicit source system,
- explicit field or endpoint mapping,
- refresh cadence,
- failure behavior,
- owner/action display rule where applicable,
- and a validation or reconciliation method.

## First TractionOS Consumption Slice

The first slice should be:

1. Leadership flash KPIs with freshness and certification badges.
2. Sales scoreboard rows for rep activity, activity-vs-standard, pipeline, stale opportunities, and certified financials when available.
3. Exception widgets for stuck orders and stale opportunities.
4. Visible FAIL states for unmapped branch/rep or failed reconciliation.

## Archive Rule

Do not archive this repo until the v1 KPI/control definitions are implemented or linked from TractionOS and the source mappings are captured in a durable place.
