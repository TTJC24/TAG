import json
import os
from dataclasses import dataclass


def _parse_csv(value: str) -> tuple[str, ...]:
    items = [item.strip() for item in value.split(",") if item.strip()]
    return tuple(items)


def _parse_json_object(value: str, env_name: str) -> dict[str, str]:
    if not value.strip():
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError(f"{env_name} must be a JSON object.")
    for key, val in parsed.items():
        if not isinstance(key, str) or not isinstance(val, str):
            raise ValueError(f"{env_name} must map string keys to string values.")
    return parsed


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
    acumatica_auth_path: str
    acumatica_branches_path: str
    acumatica_sales_orders_path: str
    acumatica_ar_invoices_path: str
    acumatica_inventory_path: str

    pipedrive_base_url: str
    pipedrive_api_token: str
    pipedrive_timeout_seconds: int
    pipedrive_users_path: str
    pipedrive_deals_path: str
    pipedrive_activities_path: str
    pipedrive_stages_path: str

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

    acumatica_branch_codes: tuple[str, ...]
    branch_entity_mapping: dict[str, str]
    rep_mapping: dict[str, str]
    stage_include_ids: tuple[str, ...]
    activity_type_include_names: tuple[str, ...]

    @property
    def branch_scope_configured(self) -> bool:
        return bool(self.acumatica_branch_codes)

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
            acumatica_auth_path=os.getenv("ACUMATICA_AUTH_PATH", "/entity/auth/login"),
            acumatica_branches_path=os.getenv("ACUMATICA_BRANCHES_PATH", "/entity/Default/22.200.001/Branch"),
            acumatica_sales_orders_path=os.getenv(
                "ACUMATICA_SALES_ORDERS_PATH", "/entity/Default/22.200.001/SalesOrder"
            ),
            acumatica_ar_invoices_path=os.getenv(
                "ACUMATICA_AR_INVOICES_PATH", "/entity/Default/22.200.001/ARInvoice"
            ),
            acumatica_inventory_path=os.getenv("ACUMATICA_INVENTORY_PATH", "/entity/Default/22.200.001/StockItem"),
            pipedrive_base_url=os.getenv("PIPEDRIVE_BASE_URL", "https://api.pipedrive.com/v1"),
            pipedrive_api_token=os.getenv("PIPEDRIVE_API_TOKEN", ""),
            pipedrive_timeout_seconds=int(os.getenv("PIPEDRIVE_TIMEOUT_SECONDS", "30")),
            pipedrive_users_path=os.getenv("PIPEDRIVE_USERS_PATH", "/users"),
            pipedrive_deals_path=os.getenv("PIPEDRIVE_DEALS_PATH", "/deals"),
            pipedrive_activities_path=os.getenv("PIPEDRIVE_ACTIVITIES_PATH", "/activities"),
            pipedrive_stages_path=os.getenv("PIPEDRIVE_STAGES_PATH", "/stages"),
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
            acumatica_branch_codes=_parse_csv(os.getenv("ACUMATICA_BRANCH_CODES", "")),
            branch_entity_mapping=_parse_json_object(os.getenv("BRANCH_ENTITY_MAPPING_JSON", ""), "BRANCH_ENTITY_MAPPING_JSON"),
            rep_mapping=_parse_json_object(os.getenv("REP_MAPPING_JSON", ""), "REP_MAPPING_JSON"),
            stage_include_ids=_parse_csv(os.getenv("STAGE_INCLUDE_IDS", "")),
            activity_type_include_names=_parse_csv(os.getenv("ACTIVITY_TYPE_INCLUDE_NAMES", "")),
        )
