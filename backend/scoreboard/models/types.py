from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Literal

StatusType = Literal["certified", "provisional", "stale", "failed", "FAIL"]
FreshnessType = Literal["fresh", "delayed", "stale", "failed", "unknown"]


@dataclass
class FailState:
    reason: str
    source: str
    as_of: datetime | None = None
    state: Literal["FAIL"] = "FAIL"

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.as_of is not None:
            payload["as_of"] = self.as_of.isoformat()
        return payload


@dataclass
class KpiEnvelope:
    name: str
    source_system: str
    value: Any = None
    as_of_timestamp: datetime | None = None
    freshness_state: FreshnessType = "unknown"
    certification_state: StatusType = "provisional"
    fail_state: FailState | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.as_of_timestamp is not None:
            payload["as_of_timestamp"] = self.as_of_timestamp.isoformat()
        if self.fail_state is not None:
            payload["fail_state"] = self.fail_state.to_dict()
        return payload
