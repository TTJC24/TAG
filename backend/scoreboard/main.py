import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from backend.scoreboard.api import routes


ROUTES: dict[str, callable] = {
    "/health": lambda: {"status": "ok", "mode": "read-only", "service": "scoreboard"},
    "/api/v1/leadership-flash": routes.leadership_flash,
    "/api/v1/sales-scoreboard": routes.sales_scoreboard,
    "/api/v1/financial/revenue-by-rep": routes.financial_revenue_by_rep,
    "/api/v1/financial/margin-by-rep": routes.financial_margin_by_rep,
    "/api/v1/financial/validation-status": routes.financial_validation_status,
    "/api/v1/exceptions/stale-opportunities": routes.stale_opportunities,
    "/api/v1/exceptions/stuck-orders": routes.stuck_orders,
    "/api/v1/platform/status": routes.platform_status,
    "/api/v1/platform/connectors": routes.connector_status,
}


def resolve_path(path: str) -> tuple[int, dict[str, Any]]:
    handler = ROUTES.get(path)
    if handler is None:
        return 404, {"error": "not_found", "path": path}
    return 200, handler()


class ScoreboardHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        status, payload = resolve_path(self.path)
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(host: str = "0.0.0.0", port: int = 8000) -> None:
    server = HTTPServer((host, port), ScoreboardHandler)
    server.serve_forever()
