import json
import time
from datetime import datetime, timezone
from http import cookiejar
from typing import Any
from urllib import error, parse, request

from backend.scoreboard.connectors.base import ConnectorContext
from backend.scoreboard.models.types import FailState


class AcumaticaClient:
    """Read-only Acumatica connector for v1 integration plumbing."""

    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        company: str,
        timeout_seconds: int,
        auth_path: str,
        retries: int = 2,
        backoff_seconds: float = 0.5,
    ) -> None:
        self.context = ConnectorContext(source="acumatica", base_url=base_url.rstrip("/"), timeout_seconds=timeout_seconds)
        self.username = username
        self.password = password
        self.company = company
        self.auth_path = auth_path
        self.retries = retries
        self.backoff_seconds = backoff_seconds
        self._authenticated = False
        self._opener = request.build_opener(request.HTTPCookieProcessor(cookiejar.CookieJar()))

    def _url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{self.context.base_url}{path if path.startswith('/') else '/' + path}"

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

    def _request_json(self, method: str, path: str, domain: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self._url(path)
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            req = request.Request(url, data=body, method=method, headers=headers)
            try:
                with self._opener.open(req, timeout=self.context.timeout_seconds) as response:
                    content = response.read().decode("utf-8")
                    if not content.strip():
                        return {"data": []}
                    return json.loads(content)
            except (error.HTTPError, error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(self.backoff_seconds * (2**attempt))
                    continue
                return self._failure(f"Acumatica request failed for {domain}: {exc}", domain)

        return self._failure(f"Acumatica request failed for {domain}: {last_error}", domain)

    def authenticate(self) -> dict[str, Any]:
        if not self.context.base_url or not self.username or not self.password or not self.company:
            return self._failure("Acumatica credentials/base URL are not fully configured.", "auth")
        result = self._request_json(
            "POST",
            self.auth_path,
            domain="auth",
            payload={"name": self.username, "password": self.password, "company": self.company},
        )
        if "fail_state" in result:
            self._authenticated = False
            return result
        self._authenticated = True
        now = datetime.now(timezone.utc)
        return {
            "read_only": True,
            "source": self.context.source,
            "domain": "auth",
            "as_of": now.isoformat(),
            "records": [],
            "authenticated": True,
        }

    def _read_domain(self, domain: str, path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._authenticated:
            auth_result = self.authenticate()
            if auth_result.get("authenticated") is not True:
                return auth_result

        target_path = path
        if query:
            target_path = f"{path}?{parse.urlencode(query)}"
        result = self._request_json("GET", target_path, domain=domain)
        if "fail_state" in result:
            return result
        records = result.get("value") if isinstance(result, dict) and "value" in result else result.get("data", result)
        now = datetime.now(timezone.utc)
        return {
            "read_only": True,
            "source": self.context.source,
            "domain": domain,
            "as_of": now.isoformat(),
            "records": records if isinstance(records, list) else [records],
        }

    def fetch_branches(self, path: str) -> dict[str, Any]:
        return self._read_domain("branches", path)

    def fetch_sales_orders(self, path: str, top: int = 200) -> dict[str, Any]:
        return self._read_domain("sales_orders", path, query={"$top": top})

    def fetch_ar_invoices(self, path: str, top: int = 200) -> dict[str, Any]:
        return self._read_domain("ar_invoices", path, query={"$top": top})

    def fetch_inventory_dead_stock_candidates(self, path: str, top: int = 200) -> dict[str, Any]:
        return self._read_domain("inventory_dead_stock", path, query={"$top": top})
