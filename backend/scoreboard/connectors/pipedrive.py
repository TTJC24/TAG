import json
import time
from datetime import datetime, timezone
from typing import Any
from urllib import error, parse, request

from backend.scoreboard.connectors.base import ConnectorContext
from backend.scoreboard.models.types import FailState


class PipedriveClient:
    """Read-only Pipedrive connector for v1 integration plumbing."""

    def __init__(self, base_url: str, api_token: str, timeout_seconds: int, retries: int = 2, backoff_seconds: float = 0.5) -> None:
        self.context = ConnectorContext(source="pipedrive", base_url=base_url.rstrip("/"), timeout_seconds=timeout_seconds)
        self.api_token = api_token
        self.retries = retries
        self.backoff_seconds = backoff_seconds

    def _url(self, path: str, query: dict[str, Any] | None = None) -> str:
        target = path if path.startswith("http://") or path.startswith("https://") else f"{self.context.base_url}{path if path.startswith('/') else '/' + path}"
        query_params = {"api_token": self.api_token}
        if query:
            query_params.update(query)
        return f"{target}?{parse.urlencode(query_params)}"

    def _failure(self, reason: str, domain: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        return {
            "read_only": True,
            "source": self.context.source,
            "domain": domain,
            "as_of": now.isoformat(),
            "records": [],
            "fail_state": FailState(reason=reason, source=self.context.source, as_of=now).to_dict(),
        }

    def _get(self, domain: str, path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.context.base_url or not self.api_token:
            return self._failure("Pipedrive base URL/api token are not fully configured.", domain)

        url = self._url(path, query=query)
        req = request.Request(url, method="GET", headers={"Accept": "application/json"})
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                with request.urlopen(req, timeout=self.context.timeout_seconds) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                    now = datetime.now(timezone.utc)
                    records = payload.get("data", []) if isinstance(payload, dict) else []
                    return {
                        "read_only": True,
                        "source": self.context.source,
                        "domain": domain,
                        "as_of": now.isoformat(),
                        "records": records if isinstance(records, list) else [records],
                    }
            except (error.HTTPError, error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(self.backoff_seconds * (2**attempt))
                    continue
                return self._failure(f"Pipedrive request failed for {domain}: {exc}", domain)

        return self._failure(f"Pipedrive request failed for {domain}: {last_error}", domain)

    def fetch_users(self, path: str) -> dict[str, Any]:
        return self._get("users", path)

    def fetch_deals(self, path: str, limit: int = 500) -> dict[str, Any]:
        return self._get("deals", path, query={"limit": limit, "status": "open"})

    def fetch_activities(self, path: str, limit: int = 500) -> dict[str, Any]:
        return self._get("activities", path, query={"limit": limit})

    def fetch_stages(self, path: str) -> dict[str, Any]:
        return self._get("stages", path)
