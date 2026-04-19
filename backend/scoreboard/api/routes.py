from backend.scoreboard.config import Settings
from backend.scoreboard.connectors.acumatica import AcumaticaClient
from backend.scoreboard.connectors.pipedrive import PipedriveClient
from backend.scoreboard.kpis.services import SalesKpiService
from backend.scoreboard.models.types import ApiListResponse, CertificationState, FreshnessState, KpiEnvelope
from backend.scoreboard.normalization.mapper import build_normalization_scaffold


def _build_dependencies() -> tuple[Settings, PipedriveClient, AcumaticaClient, SalesKpiService]:
    settings = Settings.from_env()
    normalization = build_normalization_scaffold(
        branch_entity_mapping=settings.branch_entity_mapping,
        rep_mapping=settings.rep_mapping,
        stage_include_ids=settings.stage_include_ids,
        activity_type_include_names=settings.activity_type_include_names or settings.qualifying_activity_types,
    )
    pipedrive = PipedriveClient(
        base_url=settings.pipedrive_base_url,
        api_token=settings.pipedrive_api_token,
        timeout_seconds=settings.pipedrive_timeout_seconds,
    )
    acumatica = AcumaticaClient(
        base_url=settings.acumatica_base_url,
        username=settings.acumatica_username,
        password=settings.acumatica_password,
        company=settings.acumatica_company,
        timeout_seconds=settings.acumatica_timeout_seconds,
        auth_path=settings.acumatica_auth_path,
    )
    service = SalesKpiService(settings=settings, normalization=normalization)
    return settings, pipedrive, acumatica, service


def _records(payload: dict) -> list[dict]:
    records = payload.get("records", [])
    return records if isinstance(records, list) else []


def leadership_flash() -> dict:
    settings, pipedrive, _, service = _build_dependencies()
    deals = _records(pipedrive.fetch_deals(settings.pipedrive_deals_path))

    items = [
        service.financial_kpi_blocked_for_branch_scope("Invoiced Revenue MTD by Rep"),
        service.financial_kpi_blocked_for_branch_scope("Gross Margin % MTD by Rep"),
        service.open_pipeline_by_rep(deals),
        KpiEnvelope(
            name="Freshness Status",
            source_system="system",
            value={"source_system": "pipedrive", "freshness_status": FreshnessState.FRESH.value},
            freshness_state=FreshnessState.FRESH,
            certification_state=CertificationState.PROVISIONAL,
        ),
        KpiEnvelope(
            name="Certification Status",
            source_system="system",
            value={"financial": "blocked_pending_extraction_and_tie_out", "sales_non_financial": "provisional"},
            freshness_state=FreshnessState.FRESH,
            certification_state=CertificationState.PROVISIONAL,
        ),
    ]
    return ApiListResponse(read_only=True, items=items).to_dict()


def sales_scoreboard() -> dict:
    settings, pipedrive, _, service = _build_dependencies()
    activities = _records(pipedrive.fetch_activities(settings.pipedrive_activities_path))
    deals = _records(pipedrive.fetch_deals(settings.pipedrive_deals_path))

    items = [
        service.financial_kpi_blocked_for_branch_scope("Invoiced Revenue MTD by Rep"),
        service.financial_kpi_blocked_for_branch_scope("Gross Margin % MTD by Rep"),
        service.activity_count_by_rep(activities),
        service.activity_vs_standard(activities, working_days_elapsed=1),
        service.open_pipeline_by_rep(deals),
        service.stale_opportunities(deals, activities),
    ]
    return ApiListResponse(read_only=True, items=items).to_dict()


def stale_opportunities() -> dict:
    settings, pipedrive, _, service = _build_dependencies()
    activities = _records(pipedrive.fetch_activities(settings.pipedrive_activities_path))
    deals = _records(pipedrive.fetch_deals(settings.pipedrive_deals_path))
    return ApiListResponse(read_only=True, items=[service.stale_opportunities(deals, activities)]).to_dict()


def stuck_orders() -> dict:
    settings, _, acumatica, service = _build_dependencies()
    orders_payload = acumatica.fetch_sales_orders(settings.acumatica_sales_orders_path)
    if "fail_state" in orders_payload:
        return ApiListResponse(read_only=True, items=[service.financial_kpi_blocked_for_branch_scope("Stuck Orders")]).to_dict()
    return ApiListResponse(read_only=True, items=[service.financial_kpi_blocked_for_branch_scope("Stuck Orders")]).to_dict()


def platform_status() -> dict:
    settings, pipedrive, acumatica, service = _build_dependencies()
    activities = _records(pipedrive.fetch_activities(settings.pipedrive_activities_path))
    deals = _records(pipedrive.fetch_deals(settings.pipedrive_deals_path))
    branches = _records(acumatica.fetch_branches(settings.acumatica_branches_path))

    runtime_branch_codes = [str(row.get("BranchCD") or row.get("branch_code") or row.get("id") or "") for row in branches]
    runtime_rep_names = [
        str(row.get("owner_name") or row.get("user_id") or "unassigned")
        for row in [*activities, *deals]
    ]
    unmapped_branches = service.normalization.unmapped_branch_codes(runtime_branch_codes)
    unmapped_reps = service.normalization.unmapped_rep_names(runtime_rep_names)
    branch_mapping_complete = settings.branch_scope_configured and not unmapped_branches
    rep_mapping_complete = bool(settings.rep_mapping) and not unmapped_reps

    item = KpiEnvelope(
        name="Certification Status",
        source_system="system",
        value={
            "branch_scope": "configured" if settings.branch_scope_configured else "missing",
            "branch_mapping_state": "governed_complete" if branch_mapping_complete else "governed_incomplete",
            "rep_mapping_state": "governed_complete" if rep_mapping_complete else "governed_incomplete",
            "mapping_completeness": {
                "branch_mapping_complete": branch_mapping_complete,
                "rep_mapping_complete": rep_mapping_complete,
            },
            "unmapped_exceptions": {
                "branches": unmapped_branches,
                "reps": unmapped_reps,
            },
            "financial_certification_blockers": [
                "certified_acumatica_extraction_not_implemented",
                "certified_tie_out_not_implemented",
            ],
        },
        freshness_state=FreshnessState.FRESH,
        certification_state=CertificationState.PROVISIONAL,
    )
    return ApiListResponse(read_only=True, items=[item]).to_dict()


def connector_status() -> dict:
    settings, pipedrive, acumatica, _ = _build_dependencies()
    items = [
        pipedrive.fetch_users(settings.pipedrive_users_path),
        pipedrive.fetch_stages(settings.pipedrive_stages_path),
        acumatica.fetch_branches(settings.acumatica_branches_path),
    ]
    return {"read_only": True, "items": items}
