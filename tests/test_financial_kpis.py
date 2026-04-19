from datetime import datetime, timezone
import json
import os

from backend.scoreboard.config import Settings
from backend.scoreboard.kpis.financial import AcumaticaFinancialExtractor, FinancialCutoff, FinancialKpiService
from backend.scoreboard.models.types import CertificationState
from backend.scoreboard.normalization.mapper import build_normalization_scaffold


class FakeAcumaticaClient:
    def __init__(self, records):
        self.records = records

    def fetch_ar_invoices(self, path: str, top: int = 200):
        return {"records": self.records, "read_only": True, "source": "acumatica", "domain": "ar_invoices"}


def _settings(monkeypatch) -> Settings:
    monkeypatch.setenv("ACUMATICA_FINANCIAL_DATE_FIELD", "invoice_date")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_BRANCH_FIELD", "branch")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_REP_FIELD", "rep")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_REVENUE_FIELD", "revenue")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_COST_FIELD", "cost")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD", "gross_profit")
    monkeypatch.setenv("ACUMATICA_BRANCH_CODES", "FS,BL")
    monkeypatch.setenv("BRANCH_ENTITY_MAPPING_JSON", '{"FS":"FS","BL":"BL"}')
    monkeypatch.setenv("REP_MAPPING_JSON", '{"Rep A":"Rep A","Rep B":"Rep B"}')
    if "FINANCIAL_VALIDATION_ARTIFACT_PATH" not in os.environ:
        monkeypatch.setenv("FINANCIAL_VALIDATION_ARTIFACT_PATH", "artifacts/financial_validation/test-latest.json")
    return Settings.from_env()


def _service(monkeypatch, records) -> FinancialKpiService:
    settings = _settings(monkeypatch)
    normalization = build_normalization_scaffold(
        settings.branch_entity_mapping,
        settings.rep_mapping,
        settings.stage_include_ids,
        settings.activity_type_include_names or settings.qualifying_activity_types,
    )
    return FinancialKpiService(
        settings=settings,
        normalization=normalization,
        extractor=AcumaticaFinancialExtractor(settings=settings, client=FakeAcumaticaClient(records)),
    )


def test_cutoff_logic_prior_closed_day_et():
    now_utc = datetime(2026, 4, 10, 15, 0, tzinfo=timezone.utc)
    cutoff_utc = FinancialCutoff.prior_closed_cutoff_utc(now_utc, "America/New_York")
    assert cutoff_utc.isoformat() == "2026-04-10T03:59:59+00:00"


def test_branch_entity_scoped_extraction_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "XX", "rep": "Rep A", "revenue": "30", "cost": "10", "gross_profit": "20", "invoice_ref": "INV-2", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "branch_out_of_scope:XX" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_unmapped_row_fail_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Unknown Rep", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "unmapped_rep:Unknown Rep" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_reconciliation_pass_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
            {"invoice_date": "2026-04-06T12:00:00+00:00", "branch": "BL", "rep": "Rep B", "revenue": "50", "cost": "20", "gross_profit": "30", "invoice_ref": "INV-2", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.CERTIFIED
    assert kpi.fail_state is None


def test_reconciliation_fail_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )

    def _bad_reconcile(rows, rep_totals):
        return ["tie_out_failed:forced_test"]

    object.__setattr__(service, "_reconcile", _bad_reconcile)
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "tie_out_failed:forced_test" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_certification_gate_requires_source_field_config(monkeypatch):
    monkeypatch.setenv("ACUMATICA_FINANCIAL_DATE_FIELD", "")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_BRANCH_FIELD", "")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_REP_FIELD", "")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_REVENUE_FIELD", "")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_COST_FIELD", "")
    monkeypatch.setenv("ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD", "")
    settings = Settings.from_env()
    normalization = build_normalization_scaffold(settings.branch_entity_mapping, settings.rep_mapping, (), settings.qualifying_activity_types)
    service = FinancialKpiService(
        settings=settings,
        normalization=normalization,
        extractor=AcumaticaFinancialExtractor(settings=settings, client=FakeAcumaticaClient([])),
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "missing_financial_source_field_config" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_extraction_cap_failure_behavior(monkeypatch):
    monkeypatch.setenv("FINANCIAL_EXTRACT_TOP", "1")
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "financial_extract_incomplete:row_count_hit_cap:1" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_completeness_behavior_below_cap_allows_certification(monkeypatch):
    monkeypatch.setenv("FINANCIAL_EXTRACT_TOP", "2")
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.CERTIFIED
    assert kpi.value["extraction_diagnostics"]["completeness_status"] == "complete"


def test_missing_required_field_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "invoice_ref": "INV-3", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "missing_required_field:gross_profit" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_validation_endpoint_blockers(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Unknown Rep", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    payload = service.financial_validation_status()
    assert payload.value["rep_mapping_completeness"] is False
    assert "rep_mapping_incomplete" in payload.value["blocker_list"]


def test_validation_artifact_shape_and_write(monkeypatch, tmp_path):
    artifact_path = tmp_path / "financial-validation.json"
    monkeypatch.setenv("FINANCIAL_VALIDATION_ARTIFACT_PATH", str(artifact_path))
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    payload = service.financial_validation_status()
    assert artifact_path.exists()
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert artifact["configured_source_path"] == payload.value["configured_source_path"]
    assert artifact["configured_field_bindings"] == payload.value["configured_field_bindings"]
    assert artifact["certification_status"] == payload.value["certification_status"]
    assert artifact["blocker_list"] == payload.value["blocker_list"]


def test_signed_amount_and_void_diagnostics(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "10", "cost": "4", "gross_profit": "6", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "2", "cost": "1", "gross_profit": "1", "invoice_ref": "CM-1", "line_nbr": 1, "doc_type": "credit memo"},
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "999", "cost": "999", "gross_profit": "0", "invoice_ref": "VOID-1", "line_nbr": 1, "doc_type": "void"},
        ],
    )
    payload = service.financial_validation_status()
    assert payload.value["credit_memo_return_signed_row_count"] == 1
    assert payload.value["excluded_void_voided_count"] == 1


def test_tie_out_and_certification_payload_structure(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40", "invoice_ref": "INV-1", "line_nbr": 1, "doc_type": "invoice"},
        ],
    )
    payload = service.financial_validation_status()
    assert payload.value["tie_out_status"] == "passed"
    assert payload.value["certification_status"] == CertificationState.CERTIFIED.value
    assert isinstance(payload.value["blocker_list"], list)


def test_approved_grain_behavior_requires_invoice_ref_plus_line_number(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "FS",
                "rep": "Rep A",
                "revenue": "100",
                "cost": "60",
                "gross_profit": "40",
                "doc_type": "invoice",
            },
        ],
    )
    kpi = service.financial_validation_status()
    assert kpi.certification_state == CertificationState.FAIL
    assert "missing_required_field:certified_grain_key(invoice_ref+line_nbr)" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_rep_attribution_rule_requires_line_level_rep(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "FS",
                "rep": "",
                "revenue": "100",
                "cost": "60",
                "gross_profit": "40",
                "invoice_ref": "INV-1",
                "line_nbr": 1,
                "doc_type": "invoice",
            },
        ],
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "rep_attribution_missing:INV-1:1" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_credit_memo_and_return_are_forced_negative(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "FS",
                "rep": "Rep A",
                "revenue": "50",
                "cost": "20",
                "gross_profit": "30",
                "invoice_ref": "CM-1",
                "line_nbr": 1,
                "doc_type": "credit memo",
            },
            {
                "invoice_date": "2026-04-06T12:00:00+00:00",
                "branch": "FS",
                "rep": "Rep A",
                "revenue": "10",
                "cost": "2",
                "gross_profit": "8",
                "invoice_ref": "RTN-1",
                "line_nbr": 1,
                "doc_type": "return",
            },
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    row = kpi.value["rows"][0]
    assert row["revenue_mtd"] == -60.0
    assert row["cost_mtd"] == -22.0
    assert row["gross_profit_mtd"] == -38.0


def test_void_rows_are_excluded_from_certified_financial_totals(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "FS",
                "rep": "Rep A",
                "revenue": "100",
                "cost": "60",
                "gross_profit": "40",
                "invoice_ref": "INV-1",
                "line_nbr": 1,
                "doc_type": "invoice",
            },
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "FS",
                "rep": "Rep A",
                "revenue": "999",
                "cost": "999",
                "gross_profit": "0",
                "invoice_ref": "VOID-1",
                "line_nbr": 1,
                "doc_type": "void",
            },
        ],
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.value["rows"][0]["revenue_mtd"] == 100.0


def test_out_of_scope_branch_is_hard_fail(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {
                "invoice_date": "2026-04-05T12:00:00+00:00",
                "branch": "ZZ",
                "rep": "Rep A",
                "revenue": "100",
                "cost": "60",
                "gross_profit": "40",
                "invoice_ref": "INV-1",
                "line_nbr": 1,
                "doc_type": "invoice",
            },
        ],
    )
    kpi = service.financial_validation_status()
    assert kpi.certification_state == CertificationState.FAIL
    assert "branch_out_of_scope:ZZ" in (kpi.fail_state.reason if kpi.fail_state else "")
