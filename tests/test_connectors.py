from backend.scoreboard.connectors.acumatica import AcumaticaClient
from backend.scoreboard.connectors.pipedrive import PipedriveClient


def test_acumatica_connector_auth_requires_config():
    client = AcumaticaClient("", "", "", "", 30, "/entity/auth/login")
    payload = client.authenticate()

    assert payload["read_only"] is True
    assert payload["source"] == "acumatica"
    assert payload["domain"] == "auth"
    assert payload["fail_state"]["state"] == "FAIL"


def test_pipedrive_connector_requires_token():
    client = PipedriveClient("https://api.pipedrive.com/v1", "", 30)
    payload = client.fetch_users("/users")

    assert payload["read_only"] is True
    assert payload["source"] == "pipedrive"
    assert payload["domain"] == "users"
    assert payload["fail_state"]["state"] == "FAIL"
