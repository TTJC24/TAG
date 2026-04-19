from dataclasses import dataclass
from datetime import datetime, timezone

from backend.scoreboard.models.types import CertificationState, FailState, FreshnessState, KpiEnvelope


@dataclass(frozen=True)
class KpiDefinition:
    name: str
    source_system: str


KPI_DEFINITIONS = [
    KpiDefinition(name="Invoiced Revenue MTD by Rep", source_system="acumatica"),
    KpiDefinition(name="Gross Margin % MTD by Rep", source_system="acumatica"),
    KpiDefinition(name="Activity Count by Rep", source_system="pipedrive"),
    KpiDefinition(name="Activity vs Standard by Rep", source_system="pipedrive"),
    KpiDefinition(name="Open Pipeline by Rep", source_system="pipedrive"),
    KpiDefinition(name="Stale Opportunities", source_system="pipedrive"),
    KpiDefinition(name="Open Order Backlog", source_system="acumatica"),
    KpiDefinition(name="Stuck Orders", source_system="acumatica"),
    KpiDefinition(name="Dead Stock Moved", source_system="acumatica"),
    KpiDefinition(name="Freshness Status", source_system="system"),
    KpiDefinition(name="Certification Status", source_system="system"),
]


def placeholder_kpi(defn: KpiDefinition) -> KpiEnvelope:
    now = datetime.now(timezone.utc)
    return KpiEnvelope(
        name=defn.name,
        source_system=defn.source_system,
        as_of_timestamp=now,
        freshness_state=FreshnessState.UNKNOWN,
        certification_state=CertificationState.FAIL,
        fail_state=FailState(
            reason="KPI implementation pending source integration and tie-out certification checks.",
            source=defn.source_system,
            as_of=now,
        ),
        notes=[
            "Locked v1 business rules are defined in docs/control-packet.md and docs/kpi-spec.md.",
            "Financial and branch-sensitive KPIs remain uncertified until branch scope is provided.",
        ],
    )


def build_sales_scoreboard() -> list[KpiEnvelope]:
    target_names = {
        "Invoiced Revenue MTD by Rep",
        "Gross Margin % MTD by Rep",
        "Activity Count by Rep",
        "Activity vs Standard by Rep",
        "Open Pipeline by Rep",
        "Stale Opportunities",
        "Dead Stock Moved",
    }
    return [placeholder_kpi(k) for k in KPI_DEFINITIONS if k.name in target_names]


def build_leadership_flash() -> list[KpiEnvelope]:
    target_names = {
        "Invoiced Revenue MTD by Rep",
        "Gross Margin % MTD by Rep",
        "Open Pipeline by Rep",
        "Open Order Backlog",
        "Stuck Orders",
        "Freshness Status",
        "Certification Status",
    }
    return [placeholder_kpi(k) for k in KPI_DEFINITIONS if k.name in target_names]
