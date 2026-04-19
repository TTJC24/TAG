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


def test_financial_kpi_endpoints_contract_shape():
    for path in ("/api/v1/financial/revenue-by-rep", "/api/v1/financial/margin-by-rep"):
        status, payload = resolve_path(path)
        assert status == 200
        assert payload["read_only"] is True
        assert len(payload["items"]) == 1
        item = payload["items"][0]
        assert "as_of_timestamp" in item
        assert "freshness_status" in item
        assert "certification_status" in item
        assert "failure_reason" in item


def test_financial_validation_endpoint_shape():
    status, payload = resolve_path("/api/v1/financial/validation-status")
    assert status == 200
    assert payload["read_only"] is True
    assert len(payload["items"]) == 1
    value = payload["items"][0]["value"]
    assert "run_timestamp_utc" in value
    assert "artifact_path" in value
    assert "configured_source_path" in value
    assert "configured_field_bindings" in value
    assert "row_count_extracted" in value
    assert "excluded_void_voided_count" in value
    assert "credit_memo_return_signed_row_count" in value
    assert "unmapped_rep_count" in value
    assert "out_of_scope_branch_count" in value
    assert "completeness_status" in value
    assert "field_binding_completeness" in value
    assert "branch_scope_completeness" in value
    assert "rep_mapping_completeness" in value
    assert "extraction_completeness" in value
    assert "tie_out_status" in value
    assert "certification_status" in value
    assert "blocker_list" in value
