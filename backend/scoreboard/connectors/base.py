from dataclasses import dataclass


@dataclass(frozen=True)
class ConnectorContext:
    source: str
    base_url: str
    timeout_seconds: int
