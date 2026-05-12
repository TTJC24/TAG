---
description: Add a new KPI to the Scorecard with structured goal definition
argument-hint: "<name>" --owner <person> --entity <FS|BL|USA> --goal <expr> [--cadence weekly|monthly]
---

# /add-measurable

Add a new KPI row to the Scorecard. Forces the goal to be expressed structurally (direction + value), not as a hostile text blob.

## Input

- Positional: the measurable name (in quotes if multi-word).
- `--owner <hint>` — person's name or initial; fuzzy resolved against the active org members.
- `--entity <code>` — `FS`, `BL`, or `USA`. The measurable is added to that org's Scorecard only. To add the same KPI to multiple entities, run the command three times.
- `--goal <expr>` — structured goal:
  - `gte:<n>` (e.g. `gte:0.50` for 50%, `gte:250000` for $250k)
  - `lte:<n>`
  - `eq:<n>`
  - `between:<lo>..<hi>`
  - `trend_down` (no value — slope-based)
  - `trend_up`
- `--cadence` — `weekly` (default) or `monthly`.
- `--unit` — optional. Defaults inferred from goal expression and name (revenue → currency, fill rate → percent, DSO → days). If unsure, ask.
- `--format-hint` — optional. One of `currency_usd | percent | days | turns | count | currency_usd_trend`.
- `--formula` — optional human-readable formula for tooltips.

## Flow

1. Resolve owner via fuzzy match. Ambiguous → ask.
2. Parse `--goal` into `goalDirection` + `goalValue` (and `goalSecondary` for `between`).
3. Validate: percent goals must be stored as decimals; currency as integer cents in the column but specified as dollars on the CLI. Reject `--goal gte:50` for a percent KPI ("did you mean 0.50?").
4. Compute `displayOrder` = `max(displayOrder) + 10` so manual reordering has room.
5. Insert the `measurables` row.
6. Backfill the last 4 weeks' `entries` as `{actual: null, source: 'system'}` so the trailing-weeks columns render immediately.
7. Audit log + Liveblocks broadcast to the Scorecard room.

## Permissions

Admin only. Members who want to propose a new measurable should raise an Issue.

## Examples

```
/add-measurable "Cash on Hand" --owner Tim --entity FS --goal gte:500000 --cadence weekly --format-hint currency_usd
/add-measurable "Pick Accuracy %" --owner Tom --entity FS --goal gte:0.98 --cadence weekly --format-hint percent
/add-measurable "Overtime Hours" --owner Chip --entity BL --goal trend_down --cadence weekly --format-hint count
```
