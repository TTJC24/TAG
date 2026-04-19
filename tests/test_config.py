from backend.scoreboard.config import Settings


def test_connector_config_loading(monkeypatch):
    monkeypatch.setenv("ACUMATICA_BASE_URL", "https://acu.example")
    monkeypatch.setenv("ACUMATICA_USERNAME", "u")
    monkeypatch.setenv("ACUMATICA_PASSWORD", "p")
    monkeypatch.setenv("ACUMATICA_COMPANY", "c")
    monkeypatch.setenv("PIPEDRIVE_API_TOKEN", "token")

    settings = Settings.from_env()

    assert settings.acumatica_base_url == "https://acu.example"
    assert settings.pipedrive_api_token == "token"
