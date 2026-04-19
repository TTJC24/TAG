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

    v1_entities: tuple[str, ...]
    pipedrive_owner_scope: str
    activity_standard_touches_per_workday: int
    qualifying_activity_types: tuple[str, ...]
    pipeline_stage_scope: str
    financial_cutoff_timezone: str
    financial_cutoff_local_time: str
    stale_opportunity_no_qualifying_activity_days: int
    stale_opportunity_same_stage_days: int
    stuck_order_no_progress_days: int
    dead_stock_on_hand_days: int
    dead_stock_no_sales_days: int

    acumatica_branch_codes_required_todo: str

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
            v1_entities=("FS", "BL"),
            pipedrive_owner_scope="all_salespeople",
            activity_standard_touches_per_workday=int(os.getenv("ACTIVITY_STANDARD_TOUCHES_PER_WORKDAY", "8")),
            qualifying_activity_types=(
                "face-to-face meeting",
                "jobsite visit",
                "other meeting",
            ),
            pipeline_stage_scope="all_active_non_won_non_lost",
            financial_cutoff_timezone="America/New_York",
            financial_cutoff_local_time="23:59:59",
            stale_opportunity_no_qualifying_activity_days=int(
                os.getenv("STALE_OPPORTUNITY_NO_ACTIVITY_DAYS", "7")
            ),
            stale_opportunity_same_stage_days=int(os.getenv("STALE_OPPORTUNITY_SAME_STAGE_DAYS", "14")),
            stuck_order_no_progress_days=int(os.getenv("STUCK_ORDER_NO_PROGRESS_DAYS", "2")),
            dead_stock_on_hand_days=int(os.getenv("DEAD_STOCK_ON_HAND_DAYS", "90")),
            dead_stock_no_sales_days=int(os.getenv("DEAD_STOCK_NO_SALES_DAYS", "90")),
            acumatica_branch_codes_required_todo=os.getenv(
                "ACUMATICA_BRANCH_CODES",
                "TODO_REQUIRED: exact Acumatica branch codes must be provided before certifying branch-sensitive KPIs.",
            ),
        )
