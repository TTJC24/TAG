from backend.scoreboard.main import resolve_path
from backend.scoreboard.models.types import CertificationState, FreshnessState


def test_sales_scoreboard_contract_shape():
    status, payload = resolve_path("/api/v1/sales-scoreboard")
    assert status == 200
    assert payload["read_only"] is True
    assert isinstance(payload["items"], list)
    assert payload["items"]

    first = payload["items"][0]
    required = {
        "name",
        "value",
        "source_system",
        "as_of_timestamp",
        "freshness_state",
        "certification_state",
    }
    assert required.issubset(first.keys())


def test_fail_state_response_format():
    status, payload = resolve_path("/api/v1/exceptions/stuck-orders")
    assert status == 200

    fail_state = payload["items"][0]["fail_state"]
    assert fail_state["state"] == CertificationState.FAIL.value
    assert isinstance(fail_state["reason"], str)
    assert fail_state["source"] == "acumatica"


def test_enums_are_exposed():
    status, payload = resolve_path("/api/v1/platform/status")
    assert status == 200

    for item in payload["items"]:
        assert item["freshness_state"] in {state.value for state in FreshnessState}
        assert item["certification_state"] in {state.value for state in CertificationState}
        assert "mapping_completeness" in item["value"]
        assert "unmapped_exceptions" in item["value"]


def test_connector_status_route_exists():
    status, payload = resolve_path("/api/v1/platform/connectors")
    assert status == 200
    assert payload["read_only"] is True
    assert len(payload["items"]) == 3
