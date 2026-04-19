from backend.scoreboard.connectors.acumatica import AcumaticaClient
from backend.scoreboard.connectors.pipedrive import PipedriveClient


def test_acumatica_connector_is_read_only_placeholder():
    client = AcumaticaClient("https://acu.example", "u", "p", "c", 30)
    payload = client.fetch_orders()

    assert payload["read_only"] is True
    assert payload["source"] == "acumatica"
    assert payload["domain"] == "sales_orders"
    assert payload["fail_state"]["state"] == "FAIL"


def test_pipedrive_connector_is_read_only_placeholder():
    client = PipedriveClient("https://api.pipedrive.com/v1", "token", 30)
    payload = client.fetch_pipeline()

    assert payload["read_only"] is True
    assert payload["source"] == "pipedrive"
    assert payload["domain"] == "pipeline"
    assert payload["fail_state"]["state"] == "FAIL"
