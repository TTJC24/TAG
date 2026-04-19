from backend.scoreboard.config import Settings
from backend.scoreboard.kpis.services import SalesKpiService
from backend.scoreboard.models.types import CertificationState
from backend.scoreboard.normalization.mapper import build_normalization_scaffold


def _settings() -> Settings:
    return Settings.from_env()


def test_provisional_sales_kpis_behavior(monkeypatch):
    monkeypatch.setenv("ACTIVITY_TYPE_INCLUDE_NAMES", "face-to-face meeting")
    settings = Settings.from_env()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {}, (), settings.activity_type_include_names),
    )

    activities = [
        {"owner_name": "Rep A", "type": "face-to-face meeting", "deal_id": 1, "due_date": "2026-04-01T00:00:00+00:00"},
        {"owner_name": "Rep A", "type": "call", "deal_id": 1, "due_date": "2026-04-02T00:00:00+00:00"},
    ]
    deals = [{"id": 1, "owner_name": "Rep A", "stage_id": "5", "value": 1000, "update_time": "2026-04-01T00:00:00+00:00"}]

    activity_count = service.activity_count_by_rep(activities)
    pipeline = service.open_pipeline_by_rep(deals)

    assert activity_count.certification_state == CertificationState.PROVISIONAL
    assert activity_count.value == [{"rep": "Rep A", "raw_count": 1}]
    assert pipeline.certification_state == CertificationState.PROVISIONAL


def test_branch_scope_required_fail_behavior(monkeypatch):
    monkeypatch.delenv("ACUMATICA_BRANCH_CODES", raising=False)
    settings = Settings.from_env()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {}, (), settings.qualifying_activity_types),
    )

    blocked = service.financial_kpi_blocked_for_branch_scope("Invoiced Revenue MTD by Rep")
    assert blocked.certification_state == CertificationState.FAIL
    assert blocked.fail_state is not None


def test_stage_inclusion_filtering():
    settings = _settings()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {}, ("1",), settings.qualifying_activity_types),
    )

    deals = [
        {"id": 1, "owner_name": "Rep A", "stage_id": "1", "value": 100},
        {"id": 2, "owner_name": "Rep A", "stage_id": "2", "value": 500},
    ]
    pipeline = service.open_pipeline_by_rep(deals)
    assert pipeline.value == [{"rep": "Rep A", "total_open_pipeline": 100.0}]
