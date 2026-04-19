from dataclasses import dataclass


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
