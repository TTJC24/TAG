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


def test_locked_business_rules_defaults():
    settings = Settings.from_env()

    assert settings.v1_entities == ("FS", "BL")
    assert settings.pipedrive_owner_scope == "all_salespeople"
    assert settings.activity_standard_touches_per_workday == 8
    assert settings.qualifying_activity_types == (
        "face-to-face meeting",
        "jobsite visit",
        "other meeting",
    )
    assert settings.stale_opportunity_no_qualifying_activity_days == 7
    assert settings.stale_opportunity_same_stage_days == 14
    assert settings.stuck_order_no_progress_days == 2
    assert settings.dead_stock_on_hand_days == 90
    assert settings.dead_stock_no_sales_days == 90


def test_branch_scope_todo_is_required():
    settings = Settings.from_env()
    assert "TODO_REQUIRED" in settings.acumatica_branch_codes_required_todo
