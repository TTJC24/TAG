from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class FreshnessState(str, Enum):
    FRESH = "fresh"
    DELAYED = "delayed"
    STALE = "stale"
    FAILED = "failed"
    UNKNOWN = "unknown"


class CertificationState(str, Enum):
    CERTIFIED = "certified"
    PROVISIONAL = "provisional"
    STALE = "stale"
    FAILED = "failed"
    FAIL = "FAIL"


@dataclass
class FailState:
    reason: str
    source: str
    as_of: datetime | None = None
    state: CertificationState = CertificationState.FAIL

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["state"] = self.state.value
        if self.as_of is not None:
            payload["as_of"] = self.as_of.isoformat()
        return payload


@dataclass
class KpiEnvelope:
    name: str
    source_system: str
    value: Any = None
    as_of_timestamp: datetime | None = None
    freshness_state: FreshnessState = FreshnessState.UNKNOWN
    certification_state: CertificationState = CertificationState.PROVISIONAL
    fail_state: FailState | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["freshness_state"] = self.freshness_state.value
        payload["certification_state"] = self.certification_state.value
        if self.as_of_timestamp is not None:
            payload["as_of_timestamp"] = self.as_of_timestamp.isoformat()
        if self.fail_state is not None:
            payload["fail_state"] = self.fail_state.to_dict()
        return payload


@dataclass
class ApiListResponse:
    read_only: bool
    items: list[KpiEnvelope]

    def to_dict(self) -> dict[str, Any]:
        return {"read_only": self.read_only, "items": [item.to_dict() for item in self.items]}
