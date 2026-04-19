from backend.scoreboard.config import Settings
from backend.scoreboard.kpis.services import SalesKpiService
from backend.scoreboard.models.types import CertificationState
from backend.scoreboard.normalization.mapper import build_normalization_scaffold


def _settings() -> Settings:
    return Settings.from_env()


def test_provisional_sales_kpis_behavior(monkeypatch):
    monkeypatch.setenv("ACTIVITY_TYPE_INCLUDE_NAMES", "face-to-face meeting")
    monkeypatch.setenv("REP_MAPPING_JSON", "{\"Rep A\":\"Rep A\"}")
    settings = Settings.from_env()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, settings.rep_mapping, (), settings.activity_type_include_names),
    )

    activities = [
        {"owner_name": "Rep A", "type": "face-to-face meeting", "deal_id": 1, "due_date": "2026-04-01T00:00:00+00:00"},
        {"owner_name": "Rep A", "type": "call", "deal_id": 1, "due_date": "2026-04-02T00:00:00+00:00"},
    ]
    deals = [{"id": 1, "owner_name": "Rep A", "stage_id": "5", "value": 1000, "update_time": "2026-04-01T00:00:00+00:00"}]

    activity_count = service.activity_count_by_rep(activities)
    pipeline = service.open_pipeline_by_rep(deals)

    assert activity_count.certification_state == CertificationState.PROVISIONAL
    assert activity_count.value == {"rows": [{"rep": "Rep A", "raw_count": 1}], "unmapped_reps": []}
    assert pipeline.certification_state == CertificationState.PROVISIONAL


def test_branch_scope_required_fail_behavior(monkeypatch):
    monkeypatch.setenv("ACUMATICA_BRANCH_CODES", "")
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
        settings=settings, normalization=build_normalization_scaffold({}, {"Rep A": "Rep A"}, ("1",), settings.qualifying_activity_types)
    )

    deals = [
        {"id": 1, "owner_name": "Rep A", "stage_id": "1", "value": 100},
        {"id": 2, "owner_name": "Rep A", "stage_id": "2", "value": 500},
    ]
    pipeline = service.open_pipeline_by_rep(deals)
    assert pipeline.value == {"rows": [{"rep": "Rep A", "total_open_pipeline": 100.0}], "unmapped_reps": []}


def test_governed_rep_mapping_application():
    settings = _settings()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {"Rep Alias": "Tim Clark"}, (), settings.qualifying_activity_types),
    )
    activities = [{"owner_name": "Rep Alias", "type": "face-to-face meeting"}]
    deals = [{"id": 1, "owner_name": "Rep Alias", "stage_id": "1", "value": 1250, "update_time": "2026-04-01T00:00:00+00:00"}]

    assert service.activity_count_by_rep(activities).value["rows"] == [{"rep": "Tim Clark", "raw_count": 1}]
    assert service.open_pipeline_by_rep(deals).value["rows"] == [{"rep": "Tim Clark", "total_open_pipeline": 1250.0}]


def test_unmapped_rep_behavior_in_kpis():
    settings = _settings()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {"Known Rep": "Known Rep"}, (), settings.qualifying_activity_types),
    )
    activities = [{"owner_name": "Unknown Rep", "type": "face-to-face meeting"}]
    activity_count = service.activity_count_by_rep(activities)
    assert activity_count.value["rows"] == []
    assert activity_count.value["unmapped_reps"] == ["Unknown Rep"]


def test_activity_inclusion_filter_behavior():
    settings = _settings()
    service = SalesKpiService(
        settings=settings,
        normalization=build_normalization_scaffold({}, {"Rep A": "Rep A"}, (), ("Other meeting",)),
    )
    activities = [
        {"owner_name": "Rep A", "type": "Other meeting"},
        {"owner_name": "Rep A", "type": "Face-to-face meeting"},
    ]
    activity_count = service.activity_count_by_rep(activities)
    assert activity_count.value["rows"] == [{"rep": "Rep A", "raw_count": 1}]
