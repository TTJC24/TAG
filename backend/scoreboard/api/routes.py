from backend.scoreboard.kpis.registry import (
    KPI_DEFINITIONS,
    build_leadership_flash,
    build_sales_scoreboard,
    placeholder_kpi,
)


def leadership_flash() -> dict:
    return {"read_only": True, "items": [x.to_dict() for x in build_leadership_flash()]}


def sales_scoreboard() -> dict:
    return {"read_only": True, "items": [x.to_dict() for x in build_sales_scoreboard()]}


def stale_opportunities() -> dict:
    item = next(k for k in KPI_DEFINITIONS if k.name == "Stale Opportunities")
    return {"read_only": True, "items": [placeholder_kpi(item).to_dict()]}


def stuck_orders() -> dict:
    item = next(k for k in KPI_DEFINITIONS if k.name == "Stuck Orders")
    return {"read_only": True, "items": [placeholder_kpi(item).to_dict()]}


def platform_status() -> dict:
    names = {"Freshness Status", "Certification Status"}
    items = [placeholder_kpi(k).to_dict() for k in KPI_DEFINITIONS if k.name in names]
    return {"read_only": True, "items": items}
