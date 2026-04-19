from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from backend.scoreboard.config import Settings
from backend.scoreboard.models.types import CertificationState, FailState, FreshnessState, KpiEnvelope
from backend.scoreboard.normalization.mapper import NormalizationScaffold


@dataclass(frozen=True)
class SalesKpiService:
    settings: Settings
    normalization: NormalizationScaffold

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _provisional(self, name: str, value: Any, notes: list[str] | None = None) -> KpiEnvelope:
        return KpiEnvelope(
            name=name,
            source_system="pipedrive",
            value=value,
            as_of_timestamp=self._now(),
            freshness_state=FreshnessState.FRESH,
            certification_state=CertificationState.PROVISIONAL,
            notes=notes or [],
        )

    def _fail(self, name: str, source: str, reason: str) -> KpiEnvelope:
        now = self._now()
        return KpiEnvelope(
            name=name,
            source_system=source,
            as_of_timestamp=now,
            freshness_state=FreshnessState.FAILED,
            certification_state=CertificationState.FAIL,
            fail_state=FailState(reason=reason, source=source, as_of=now),
        )

    def _mapped_rep(self, raw_rep: str, unmapped_reps: set[str]) -> str | None:
        mapped = self.normalization.map_rep(raw_rep)
        if mapped is None:
            unmapped_reps.add(raw_rep)
            return None
        return mapped

    def activity_count_by_rep(self, activities: list[dict[str, Any]]) -> KpiEnvelope:
        counts: dict[str, int] = defaultdict(int)
        unmapped_reps: set[str] = set()
        for activity in activities:
            activity_type = str(activity.get("type", ""))
            if not self.normalization.include_activity_type(activity_type):
                continue
            raw_owner_name = str(activity.get("owner_name") or activity.get("user_id") or "unassigned")
            owner_name = self._mapped_rep(raw_owner_name, unmapped_reps)
            if owner_name is None:
                continue
            counts[owner_name] += 1
        return self._provisional(
            "Activity Count by Rep",
            {
                "rows": [{"rep": rep, "raw_count": count} for rep, count in sorted(counts.items())],
                "unmapped_reps": sorted(unmapped_reps),
            },
            notes=[
                "Activity taxonomy uses configured qualifying Pipedrive activity type names.",
                "Governed rep mapping is applied. Unmapped reps are explicitly surfaced.",
            ],
        )

    def activity_vs_standard(self, activities: list[dict[str, Any]], working_days_elapsed: int) -> KpiEnvelope:
        count_kpi = self.activity_count_by_rep(activities)
        rows = []
        for entry in count_kpi.value["rows"]:
            target = self.settings.activity_standard_touches_per_workday * max(working_days_elapsed, 0)
            actual = entry["raw_count"]
            delta = actual - target
            delta_pct = 0.0 if target == 0 else (delta / target)
            rows.append(
                {
                    "rep": entry["rep"],
                    "actual_count": actual,
                    "target_count": target,
                    "delta": delta,
                    "delta_pct": round(delta_pct, 4),
                }
            )
        return self._provisional(
            "Activity vs Standard by Rep",
            {"rows": rows, "unmapped_reps": count_kpi.value["unmapped_reps"]},
            notes=["Governed rep mapping is applied. Unmapped reps are explicitly surfaced."],
        )

    def open_pipeline_by_rep(self, deals: list[dict[str, Any]]) -> KpiEnvelope:
        totals: dict[str, float] = defaultdict(float)
        unmapped_reps: set[str] = set()
        for deal in deals:
            stage_id = str(deal.get("stage_id", ""))
            if not self.normalization.include_stage(stage_id):
                continue
            raw_owner_name = str(deal.get("owner_name") or deal.get("user_id") or "unassigned")
            owner_name = self._mapped_rep(raw_owner_name, unmapped_reps)
            if owner_name is None:
                continue
            value = float(deal.get("value") or 0.0)
            totals[owner_name] += value
        return self._provisional(
            "Open Pipeline by Rep",
            {
                "rows": [{"rep": rep, "total_open_pipeline": round(value, 2)} for rep, value in sorted(totals.items())],
                "unmapped_reps": sorted(unmapped_reps),
            },
            notes=[
                "Pipeline is CRM operational visibility only and is not financial truth.",
                "Governed rep mapping is applied. Unmapped reps are explicitly surfaced.",
            ],
        )

    def stale_opportunities(self, deals: list[dict[str, Any]], activities: list[dict[str, Any]]) -> KpiEnvelope:
        latest_activity_by_deal: dict[str, datetime] = {}
        now = self._now()
        for activity in activities:
            if not self.normalization.include_activity_type(str(activity.get("type", ""))):
                continue
            deal_id = str(activity.get("deal_id", ""))
            raw_date = activity.get("due_date") or activity.get("marked_as_done_time")
            if not deal_id or not raw_date:
                continue
            activity_ts = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00"))
            latest_activity_by_deal[deal_id] = max(activity_ts, latest_activity_by_deal.get(deal_id, activity_ts))

        stale_rows = []
        unmapped_reps: set[str] = set()
        for deal in deals:
            stage_id = str(deal.get("stage_id", ""))
            if not self.normalization.include_stage(stage_id):
                continue
            deal_id = str(deal.get("id", ""))
            stage_change_raw = deal.get("update_time") or deal.get("stage_change_time")
            if not deal_id or not stage_change_raw:
                continue
            stage_change_ts = datetime.fromisoformat(str(stage_change_raw).replace("Z", "+00:00"))
            days_since_stage_change = (now - stage_change_ts).days
            last_activity_ts = latest_activity_by_deal.get(deal_id)
            days_since_activity = (now - last_activity_ts).days if last_activity_ts else 999999
            raw_owner_name = str(deal.get("owner_name") or deal.get("user_id") or "unassigned")
            mapped_owner = self._mapped_rep(raw_owner_name, unmapped_reps)
            if (
                days_since_activity >= self.settings.stale_opportunity_no_qualifying_activity_days
                or days_since_stage_change >= self.settings.stale_opportunity_same_stage_days
            ):
                stale_rows.append(
                    {
                        "opportunity": deal.get("title", deal_id),
                        "owner": mapped_owner or raw_owner_name,
                        "owner_mapped": mapped_owner is not None,
                        "stage": deal.get("stage_name") or stage_id,
                        "days_stale": max(days_since_activity, days_since_stage_change),
                        "next_activity_due": deal.get("next_activity_date"),
                    }
                )
        return self._provisional(
            "Stale Opportunities",
            {"rows": stale_rows, "unmapped_reps": sorted(unmapped_reps)},
            notes=["Governed rep mapping is applied. Unmapped reps are explicitly surfaced."],
        )

    def financial_kpi_blocked_for_branch_scope(self, kpi_name: str) -> KpiEnvelope:
        if self.settings.branch_scope_configured:
            return self._fail(
                kpi_name,
                source="acumatica",
                reason="Certified financial KPI extraction and tie-out logic are not implemented. Financial KPI remains blocked.",
            )
        return self._fail(
            kpi_name,
            source="acumatica",
            reason=(
                "Branch scope is not configured and certified financial KPI extraction/tie-out logic is not implemented. "
                "Financial KPI certification remains blocked."
            ),
        )
