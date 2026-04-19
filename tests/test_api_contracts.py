from backend.scoreboard.main import resolve_path


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
        "fail_state",
    }
    assert required.issubset(first.keys())


def test_fail_state_response_format():
    status, payload = resolve_path("/api/v1/exceptions/stuck-orders")
    assert status == 200

    fail_state = payload["items"][0]["fail_state"]
    assert fail_state["state"] == "FAIL"
    assert isinstance(fail_state["reason"], str)
    assert fail_state["source"] == "acumatica"
