# Backend

## Purpose
Read-only API and KPI computation scaffold for the scoreboard.

## Structure
- `backend/scoreboard/connectors/` source-specific clients
- `backend/scoreboard/ingestion/` pull plan stubs
- `backend/scoreboard/normalization/` normalization TODO stubs
- `backend/scoreboard/kpis/` KPI definitions and response builders
- `backend/scoreboard/api/` read-only endpoint routes

## Run locally
```bash
python backend/app.py
```

## Read-only endpoints
- `GET /health`
- `GET /api/v1/leadership-flash`
- `GET /api/v1/sales-scoreboard`
- `GET /api/v1/exceptions/stale-opportunities`
- `GET /api/v1/exceptions/stuck-orders`
- `GET /api/v1/platform/status`
