import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    app_env: str
    app_host: str
    app_port: int
    acumatica_base_url: str
    acumatica_username: str
    acumatica_password: str
    acumatica_company: str
    acumatica_timeout_seconds: int
    pipedrive_base_url: str
    pipedrive_api_token: str
    pipedrive_timeout_seconds: int
    financial_refresh_target_minutes: int
    operational_refresh_target_minutes: int
    activity_standard_touches_per_workday: int
    todo_stale_opportunity_days: str
    todo_stuck_order_days: str
    todo_dead_stock_rule_id: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            app_env=os.getenv("APP_ENV", "development"),
            app_host=os.getenv("APP_HOST", "0.0.0.0"),
            app_port=int(os.getenv("APP_PORT", "8000")),
            acumatica_base_url=os.getenv("ACUMATICA_BASE_URL", ""),
            acumatica_username=os.getenv("ACUMATICA_USERNAME", ""),
            acumatica_password=os.getenv("ACUMATICA_PASSWORD", ""),
            acumatica_company=os.getenv("ACUMATICA_COMPANY", ""),
            acumatica_timeout_seconds=int(os.getenv("ACUMATICA_TIMEOUT_SECONDS", "30")),
            pipedrive_base_url=os.getenv("PIPEDRIVE_BASE_URL", "https://api.pipedrive.com/v1"),
            pipedrive_api_token=os.getenv("PIPEDRIVE_API_TOKEN", ""),
            pipedrive_timeout_seconds=int(os.getenv("PIPEDRIVE_TIMEOUT_SECONDS", "30")),
            financial_refresh_target_minutes=int(os.getenv("FINANCIAL_REFRESH_TARGET_MINUTES", "1440")),
            operational_refresh_target_minutes=int(os.getenv("OPERATIONAL_REFRESH_TARGET_MINUTES", "15")),
            activity_standard_touches_per_workday=int(os.getenv("ACTIVITY_STANDARD_TOUCHES_PER_WORKDAY", "8")),
            todo_stale_opportunity_days=os.getenv("TODO_STALE_OPPORTUNITY_DAYS", "CONFIG_REQUIRED"),
            todo_stuck_order_days=os.getenv("TODO_STUCK_ORDER_DAYS", "CONFIG_REQUIRED"),
            todo_dead_stock_rule_id=os.getenv("TODO_DEAD_STOCK_RULE_ID", "CONFIG_REQUIRED"),
        )
