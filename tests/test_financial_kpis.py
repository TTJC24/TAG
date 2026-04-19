from datetime import datetime, timezone

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
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40"},
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "XX", "rep": "Rep A", "revenue": "30", "cost": "10", "gross_profit": "20"},
        ],
    )
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "branch_out_of_scope:XX" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_unmapped_row_fail_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Unknown Rep", "revenue": "100", "cost": "60", "gross_profit": "40"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "unmapped_rep:Unknown Rep" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_reconciliation_pass_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40"},
            {"invoice_date": "2026-04-06T12:00:00+00:00", "branch": "BL", "rep": "Rep B", "revenue": "50", "cost": "20", "gross_profit": "30"},
        ],
    )
    kpi = service.gross_margin_pct_mtd_by_rep()
    assert kpi.certification_state == CertificationState.CERTIFIED
    assert kpi.fail_state is None


def test_reconciliation_fail_behavior(monkeypatch):
    service = _service(
        monkeypatch,
        records=[
            {"invoice_date": "2026-04-05T12:00:00+00:00", "branch": "FS", "rep": "Rep A", "revenue": "100", "cost": "60", "gross_profit": "40"},
        ],
    )

    def _bad_reconcile(rows, rep_totals):
        return ["tie_out_failed:forced_test"]

    object.__setattr__(service, "_reconcile", _bad_reconcile)
    kpi = service.invoiced_revenue_mtd_by_rep()
    assert kpi.certification_state == CertificationState.FAILED
    assert "tie_out_failed:forced_test" in (kpi.fail_state.reason if kpi.fail_state else "")


def test_certification_gate_requires_source_field_config(monkeypatch):
    monkeypatch.delenv("ACUMATICA_FINANCIAL_DATE_FIELD", raising=False)
    monkeypatch.delenv("ACUMATICA_FINANCIAL_BRANCH_FIELD", raising=False)
    monkeypatch.delenv("ACUMATICA_FINANCIAL_REP_FIELD", raising=False)
    monkeypatch.delenv("ACUMATICA_FINANCIAL_REVENUE_FIELD", raising=False)
    monkeypatch.delenv("ACUMATICA_FINANCIAL_COST_FIELD", raising=False)
    monkeypatch.delenv("ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD", raising=False)
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
