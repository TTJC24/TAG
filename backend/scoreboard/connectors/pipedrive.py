from datetime import datetime, timezone
from typing import Any

from backend.scoreboard.connectors.base import ConnectorContext
from backend.scoreboard.models.types import FailState


class PipedriveClient:
    """Read-only Pipedrive connector scaffold for v1."""

    def __init__(self, base_url: str, api_token: str, timeout_seconds: int) -> None:
        self.context = ConnectorContext(source="pipedrive", base_url=base_url, timeout_seconds=timeout_seconds)
        self.api_token = api_token

    def _read_placeholder(self, domain: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        return {
            "read_only": True,
            "source": self.context.source,
            "domain": domain,
            "as_of": now.isoformat(),
            "records": [],
            "fail_state": FailState(
                reason="Pipedrive read connector is not wired to production endpoint yet.",
                source=self.context.source,
                as_of=now,
            ).to_dict(),
        }

    def fetch_activities(self) -> dict[str, Any]:
        return self._read_placeholder("activities")

    def fetch_pipeline(self) -> dict[str, Any]:
        return self._read_placeholder("pipeline")

    def fetch_deals(self) -> dict[str, Any]:
        return self._read_placeholder("deals")
