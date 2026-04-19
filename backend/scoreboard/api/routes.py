from backend.scoreboard.kpis.registry import (
    KPI_DEFINITIONS,
    build_leadership_flash,
    build_sales_scoreboard,
    placeholder_kpi,
)
from backend.scoreboard.models.types import ApiListResponse


def leadership_flash() -> dict:
    return ApiListResponse(read_only=True, items=build_leadership_flash()).to_dict()


def sales_scoreboard() -> dict:
    return ApiListResponse(read_only=True, items=build_sales_scoreboard()).to_dict()


def stale_opportunities() -> dict:
    item = next(k for k in KPI_DEFINITIONS if k.name == "Stale Opportunities")
    return ApiListResponse(read_only=True, items=[placeholder_kpi(item)]).to_dict()


def stuck_orders() -> dict:
    item = next(k for k in KPI_DEFINITIONS if k.name == "Stuck Orders")
    return ApiListResponse(read_only=True, items=[placeholder_kpi(item)]).to_dict()


def platform_status() -> dict:
    names = {"Freshness Status", "Certification Status"}
    items = [placeholder_kpi(k) for k in KPI_DEFINITIONS if k.name in names]
    return ApiListResponse(read_only=True, items=items).to_dict()
