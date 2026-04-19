from datetime import datetime, timezone
from typing import Any

from backend.scoreboard.connectors.base import ConnectorContext
from backend.scoreboard.models.types import FailState


class AcumaticaClient:
    """Read-only Acumatica connector scaffold for v1."""

    def __init__(self, base_url: str, username: str, password: str, company: str, timeout_seconds: int) -> None:
        self.context = ConnectorContext(source="acumatica", base_url=base_url, timeout_seconds=timeout_seconds)
        self.username = username
        self.password = password
        self.company = company

    def _read_placeholder(self, domain: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        return {
            "read_only": True,
            "source": self.context.source,
            "domain": domain,
            "as_of": now.isoformat(),
            "records": [],
            "fail_state": FailState(
                reason="Acumatica read connector is not wired to production endpoint yet.",
                source=self.context.source,
                as_of=now,
            ).to_dict(),
        }

    def fetch_invoiced_revenue(self) -> dict[str, Any]:
        return self._read_placeholder("invoiced_revenue")

    def fetch_orders(self) -> dict[str, Any]:
        return self._read_placeholder("sales_orders")

    def fetch_inventory(self) -> dict[str, Any]:
        return self._read_placeholder("inventory")

    def fetch_shipments(self) -> dict[str, Any]:
        return self._read_placeholder("shipments")
