# Production Financial Validation Runbook

## Purpose

This runbook defines the production procedure for executing and reviewing a **certified financial validation run** for Acumatica-backed financial KPIs. The validation is read-only and produces a deterministic artifact for audit review/signoff.

## Required environment variables

These values must be configured before running:

- `ACUMATICA_BASE_URL`
- `ACUMATICA_USERNAME`
- `ACUMATICA_PASSWORD`
- `ACUMATICA_COMPANY`
- `ACUMATICA_AR_INVOICES_PATH` (locked v1 default: `/entity/Default/22.200.001/ARInvoice`)
- `ACUMATICA_FINANCIAL_DATE_FIELD` (locked v1 default: `invoice_date`)
- `ACUMATICA_FINANCIAL_BRANCH_FIELD` (locked v1 default: `branch`)
- `ACUMATICA_FINANCIAL_REP_FIELD` (locked v1 default: `rep`)
- `ACUMATICA_FINANCIAL_REVENUE_FIELD` (locked v1 default: `revenue`)
- `ACUMATICA_FINANCIAL_COST_FIELD` (locked v1 default: `cost`)
- `ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD` (locked v1 default: `gross_profit`)
- `ACUMATICA_BRANCH_CODES` (locked v1: `FS,BL`)
- `BRANCH_ENTITY_MAPPING_JSON` (locked v1: `{"FS":"FS","BL":"BL"}`)
- `REP_MAPPING_JSON` (approved governed rep mapping)
- `FINANCIAL_EXTRACT_TOP` (must be high enough to avoid cap-hit incompleteness)
- `FINANCIAL_VALIDATION_ARTIFACT_PATH` (deterministic output path; default: `artifacts/financial_validation/latest.json`)

## Pre-run checks

1. Confirm production mappings are governed and loaded:
   - branch scope includes only approved entities (`FS`, `BL`)
   - rep mapping is complete and current
2. Confirm field binding configuration is non-empty and matches Acumatica payload fields.
3. Confirm extractor cap (`FINANCIAL_EXTRACT_TOP`) is not expected to truncate production volume.
4. Confirm no writeback credentials/endpoints are configured. This flow must remain read-only.

## Execute validation run

From repository root:

```bash
python - <<'PY'
import json
from backend.scoreboard.api.routes import financial_validation_status

payload = financial_validation_status()
print(json.dumps(payload, indent=2, sort_keys=True))
PY
```

This call:
- runs the financial validation checks,
- writes the artifact to `FINANCIAL_VALIDATION_ARTIFACT_PATH`,
- returns the same payload over the read-only API contract shape.

Equivalent API check when the service is running:

```bash
curl -s http://localhost:8000/api/v1/financial/validation-status | jq .
```

## Pass/Fail criteria

### Pass
Validation run is considered **pass** only when all are true:

- `completeness_status == "complete"`
- `tie_out_status == "passed"`
- `certification_status == "certified"`
- `blocker_list` is empty
- `unmapped_rep_count == 0`
- `out_of_scope_branch_count == 0`

### Fail
Validation run is **fail** if any of these occur:

- extraction error or cap-hit incompleteness
- field binding missing/mismatch
- out-of-scope branch rows present
- unmapped reps present
- tie-out failure
- any non-empty blocker list

## Evidence required before signoff

Review and archive:

1. API payload from `GET /api/v1/financial/validation-status`
2. Artifact JSON at `FINANCIAL_VALIDATION_ARTIFACT_PATH`
3. `blocker_list` and `certification_status`
4. `branch_distribution` and `rep_distribution`
5. signed amount diagnostics:
   - `credit_memo_return_signed_row_count`
   - `excluded_void_voided_count`
6. date and volume diagnostics:
   - `row_count_extracted`
   - `min_transaction_date_utc`
   - `max_transaction_date_utc`

No financial KPI certification signoff is allowed without complete evidence and a passing certification payload.
