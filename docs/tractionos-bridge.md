# TractionOS Bridge

`scoreboard` is the KPI/control-spec feeder for `tractionos`.

The repo should continue to define source-of-truth rules, KPI logic, reconciliation behavior, fail states, and freshness requirements. It should not become a separate dashboard unless there is a strong reason to keep it independent.

## Feed Into TractionOS

Move or implement stable concepts into `tractionos` when they are ready:

- leadership flash view,
- sales scoreboard,
- operational exception widgets,
- Acumatica source-of-truth logic,
- Pipedrive pipeline/activity logic,
- certified KPI definitions,
- explicit FAIL states,
- freshness timestamps,
- reconciliation blockers and warnings.

## Keep Here Until Stable

Keep these in `scoreboard` until validated:

- control packet changes,
- KPI definition debates,
- source hierarchy decisions,
- reconciliation rules,
- no-mock-data production rules,
- and test cases for certified metrics.

## Integration Boundary

`tractionos` should own the operator UI. `scoreboard` should own the KPI specification and validation logic until implementation is ready.

Possible implementation paths:

1. Implement KPI engine directly in `tractionos` once definitions are stable.
2. Keep a separate read-only KPI service only if calculations become complex enough to justify an independent runtime.
3. Use `company-brain` only for cited context and source explanation, not for financial truth or KPI computation.

## Readiness To Merge Concepts

A KPI concept is ready to move into `tractionos` when:

- source system is named,
- formula is explicit,
- freshness requirement is known,
- failure mode is defined,
- mock-data behavior is prohibited for production,
- reconciliation test cases exist,
- and an operator action exists when the metric is red or stale.
