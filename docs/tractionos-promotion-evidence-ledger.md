# TractionOS Promotion Evidence Ledger

## Purpose

`scoreboard` is a KPI/control-spec feeder for `tractionos`. It must not be treated as a standalone live production dashboard, a certified financial system, or a TractionOS-ready implementation until the evidence below is complete.

This ledger is the promotion gate for moving Scoreboard definitions, KPI logic, or source mappings into TractionOS.

## Current Status

Status: `not-ready-for-live-promotion`

Reason:
- Acumatica and Pipedrive source mappings still require production evidence.
- Certified financial KPI signoff still requires a passing validation artifact.
- TractionOS implementation ownership is not yet complete.
- No owner approval has been recorded for live use or archive.

## Required Evidence Before Promotion

Each promoted KPI, widget, or source rule must have:

- explicit source system,
- explicit field or endpoint mapping,
- refresh cadence,
- failure behavior,
- validation or reconciliation method,
- production freshness evidence,
- no-mock-data production proof,
- read-only/no-writeback proof,
- owner approval for the TractionOS destination.

## Source Boundary

Acumatica remains the financial, order, inventory, and procurement truth.

Pipedrive remains the sales activity and pipeline truth.

Scoreboard must not invent financial truth, infer missing production mappings, or use Pipedrive as revenue truth.

## Certification Boundary

Financial KPIs may only be called certified after:

- `docs/financial-validation-runbook.md` has been followed,
- the validation payload reports `certification_status == "certified"`,
- `blocker_list` is empty,
- unmapped reps and out-of-scope branches are zero,
- the validation artifact has been archived,
- and the owner approves the promotion.

Until then, financial KPI outputs are implementation scaffolding or validation candidates, not certified production results.

## TractionOS Merge Boundary

TractionOS may consume Scoreboard concepts only when the promoted item has durable evidence in this ledger or a linked successor ledger.

Do not archive Scoreboard until:

- v1 KPI/control definitions are implemented or linked from TractionOS,
- source mappings are captured in a durable place,
- the read-only/no-writeback boundary is preserved,
- and owner approval is recorded.

