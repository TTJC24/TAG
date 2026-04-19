from backend.scoreboard.connectors.base import ConnectorContext
from backend.scoreboard.models.types import FailState


class PipedriveClient:
    def __init__(self, base_url: str, api_token: str, timeout_seconds: int) -> None:
        self.context = ConnectorContext(source="pipedrive", base_url=base_url, timeout_seconds=timeout_seconds)
        self.api_token = api_token

    def fetch_stub(self, domain: str) -> dict:
        return {
            "source": self.context.source,
            "domain": domain,
            "fail_state": FailState(
                reason="Connector read path not implemented yet.",
                source=self.context.source,
            ).to_dict(),
        }
