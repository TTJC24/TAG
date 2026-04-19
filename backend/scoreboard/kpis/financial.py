from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo
from typing import Any

from backend.scoreboard.config import Settings
from backend.scoreboard.connectors.acumatica import AcumaticaClient
from backend.scoreboard.models.types import CertificationState, FailState, FreshnessState, KpiEnvelope
from backend.scoreboard.normalization.mapper import NormalizationScaffold


@dataclass(frozen=True)
class FinancialSourceFields:
    date_field: str
    branch_field: str
    rep_field: str
    revenue_field: str
    cost_field: str
    gross_profit_field: str

    def missing(self) -> list[str]:
        missing_fields = []
        for name, value in (
            ("ACUMATICA_FINANCIAL_DATE_FIELD", self.date_field),
            ("ACUMATICA_FINANCIAL_BRANCH_FIELD", self.branch_field),
            ("ACUMATICA_FINANCIAL_REP_FIELD", self.rep_field),
            ("ACUMATICA_FINANCIAL_REVENUE_FIELD", self.revenue_field),
            ("ACUMATICA_FINANCIAL_COST_FIELD", self.cost_field),
            ("ACUMATICA_FINANCIAL_GROSS_PROFIT_FIELD", self.gross_profit_field),
        ):
            if not value.strip():
                missing_fields.append(name)
        return missing_fields


@dataclass(frozen=True)
class FinancialRow:
    source_timestamp: datetime
    branch_code: str
    rep_name: str
    revenue: Decimal
    cost: Decimal
    gross_profit: Decimal


@dataclass(frozen=True)
class NormalizedFinancialRow:
    source_timestamp: datetime
    branch_code: str
    entity: str
    rep: str
    revenue: Decimal
    cost: Decimal
    gross_profit: Decimal


class FinancialCutoff:
    @staticmethod
    def prior_closed_cutoff_utc(now_utc: datetime, tz_name: str) -> datetime:
        local_tz = ZoneInfo(tz_name)
        local_now = now_utc.astimezone(local_tz)
        prior_day = local_now.date() - timedelta(days=1)
        local_cutoff = datetime.combine(prior_day, time(23, 59, 59), tzinfo=local_tz)
        return local_cutoff.astimezone(timezone.utc)

    @staticmethod
    def month_start_utc(cutoff_utc: datetime, tz_name: str) -> datetime:
        local_tz = ZoneInfo(tz_name)
        local_cutoff = cutoff_utc.astimezone(local_tz)
        month_start_local = datetime(local_cutoff.year, local_cutoff.month, 1, 0, 0, 0, tzinfo=local_tz)
        return month_start_local.astimezone(timezone.utc)


@dataclass(frozen=True)
class AcumaticaFinancialExtractor:
    settings: Settings
    client: AcumaticaClient

    @property
    def source_fields(self) -> FinancialSourceFields:
        return FinancialSourceFields(
            date_field=self.settings.acumatica_financial_date_field,
            branch_field=self.settings.acumatica_financial_branch_field,
            rep_field=self.settings.acumatica_financial_rep_field,
            revenue_field=self.settings.acumatica_financial_revenue_field,
            cost_field=self.settings.acumatica_financial_cost_field,
            gross_profit_field=self.settings.acumatica_financial_gross_profit_field,
        )

    def extract_financial_rows(self) -> tuple[list[FinancialRow], str | None]:
        missing_fields = self.source_fields.missing()
        if missing_fields:
            return [], f"missing_financial_source_field_config:{','.join(missing_fields)}"

        payload = self.client.fetch_ar_invoices(self.settings.acumatica_ar_invoices_path, top=self.settings.financial_extract_top)
        if "fail_state" in payload:
            fail_reason = payload.get("fail_state", {}).get("reason", "acumatica_financial_extraction_failed")
            return [], f"acumatica_extraction_failed:{fail_reason}"

        raw_rows = payload.get("records", [])
        parsed: list[FinancialRow] = []
        for index, row in enumerate(raw_rows):
            try:
                parsed.append(
                    FinancialRow(
                        source_timestamp=_parse_datetime(row[self.source_fields.date_field]),
                        branch_code=str(row[self.source_fields.branch_field]).strip(),
                        rep_name=str(row[self.source_fields.rep_field]).strip(),
                        revenue=Decimal(str(row[self.source_fields.revenue_field])),
                        cost=Decimal(str(row[self.source_fields.cost_field])),
                        gross_profit=Decimal(str(row[self.source_fields.gross_profit_field])),
                    )
                )
            except Exception as exc:  # explicit fail behavior for incomplete source field mapping
                return [], f"financial_source_row_parse_error:index={index}:reason={exc}"

        return parsed, None

    def extract_revenue_rows(self) -> tuple[list[FinancialRow], str | None]:
        return self.extract_financial_rows()

    def extract_cost_rows(self) -> tuple[list[FinancialRow], str | None]:
        return self.extract_financial_rows()

    def extract_gross_profit_inputs(self) -> tuple[list[FinancialRow], str | None]:
        return self.extract_financial_rows()


@dataclass(frozen=True)
class FinancialKpiService:
    settings: Settings
    normalization: NormalizationScaffold
    extractor: AcumaticaFinancialExtractor

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _fail(self, kpi_name: str, reason: str, as_of: datetime | None = None) -> KpiEnvelope:
        event_ts = as_of or self._now()
        return KpiEnvelope(
            name=kpi_name,
            source_system="acumatica",
            value=None,
            as_of_timestamp=event_ts,
            freshness_state=FreshnessState.FAILED,
            certification_state=CertificationState.FAILED,
            fail_state=FailState(reason=reason, source="acumatica", as_of=event_ts, state=CertificationState.FAILED),
            notes=["Certified financial KPI blocked due to extraction, mapping, cutoff, or tie-out failure."],
        )

    def _normalize_rows(self, rows: list[FinancialRow]) -> tuple[list[NormalizedFinancialRow], list[str]]:
        normalized: list[NormalizedFinancialRow] = []
        errors: list[str] = []
        for row in rows:
            if row.branch_code not in self.settings.acumatica_branch_codes:
                errors.append(f"branch_out_of_scope:{row.branch_code}")
                continue
            entity = self.normalization.map_branch_to_entity(row.branch_code)
            if entity is None:
                errors.append(f"unmapped_branch:{row.branch_code}")
                continue
            rep = self.normalization.map_rep(row.rep_name)
            if rep is None:
                errors.append(f"unmapped_rep:{row.rep_name}")
                continue
            normalized.append(
                NormalizedFinancialRow(
                    source_timestamp=row.source_timestamp,
                    branch_code=row.branch_code,
                    entity=entity,
                    rep=rep,
                    revenue=row.revenue,
                    cost=row.cost,
                    gross_profit=row.gross_profit,
                )
            )
        return normalized, sorted(set(errors))

    def _reconcile(self, rows: list[NormalizedFinancialRow], rep_totals: dict[str, dict[str, Decimal]]) -> list[str]:
        failures: list[str] = []
        extracted_revenue = sum((row.revenue for row in rows), Decimal("0"))
        extracted_cost = sum((row.cost for row in rows), Decimal("0"))
        extracted_gp = sum((row.gross_profit for row in rows), Decimal("0"))

        kpi_revenue = sum((value["revenue"] for value in rep_totals.values()), Decimal("0"))
        kpi_cost = sum((value["cost"] for value in rep_totals.values()), Decimal("0"))
        kpi_gp = sum((value["gross_profit"] for value in rep_totals.values()), Decimal("0"))

        if extracted_revenue != kpi_revenue:
            failures.append(f"tie_out_failed:revenue_extracted={extracted_revenue}:revenue_kpi={kpi_revenue}")
        if extracted_cost != kpi_cost:
            failures.append(f"tie_out_failed:cost_extracted={extracted_cost}:cost_kpi={kpi_cost}")
        if extracted_gp != kpi_gp:
            failures.append(f"tie_out_failed:gross_profit_extracted={extracted_gp}:gross_profit_kpi={kpi_gp}")

        branch_totals: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        for row in rows:
            branch_totals[row.branch_code] += row.revenue
        branch_rollup = sum(branch_totals.values(), Decimal("0"))
        if branch_rollup != extracted_revenue:
            failures.append(f"branch_rollup_failed:branch_rollup={branch_rollup}:extracted_total={extracted_revenue}")

        return failures

    def _build_financial_rows(self, now_utc: datetime) -> tuple[list[NormalizedFinancialRow], datetime, datetime, list[str]]:
        cutoff_utc = FinancialCutoff.prior_closed_cutoff_utc(now_utc, self.settings.financial_cutoff_timezone)
        month_start_utc = FinancialCutoff.month_start_utc(cutoff_utc, self.settings.financial_cutoff_timezone)

        revenue_rows, err_revenue = self.extractor.extract_revenue_rows()
        cost_rows, err_cost = self.extractor.extract_cost_rows()
        gp_rows, err_gp = self.extractor.extract_gross_profit_inputs()
        errors = [err for err in (err_revenue, err_cost, err_gp) if err]
        if errors:
            return [], cutoff_utc, month_start_utc, errors

        if not (len(revenue_rows) == len(cost_rows) == len(gp_rows)):
            return [], cutoff_utc, month_start_utc, ["financial_input_row_count_mismatch"]

        filtered = [
            row
            for row in revenue_rows
            if month_start_utc <= row.source_timestamp <= cutoff_utc
        ]
        normalized_rows, mapping_errors = self._normalize_rows(filtered)
        return normalized_rows, cutoff_utc, month_start_utc, mapping_errors

    def financial_kpi_payload(self, kpi_name: str) -> KpiEnvelope:
        now_utc = self._now()
        rows, cutoff_utc, month_start_utc, base_errors = self._build_financial_rows(now_utc)
        if base_errors:
            return self._fail(kpi_name, ";".join(base_errors), as_of=cutoff_utc)

        if not rows:
            return self._fail(kpi_name, "no_rows_after_cutoff_or_mapping", as_of=cutoff_utc)

        rep_totals: dict[str, dict[str, Decimal]] = defaultdict(
            lambda: {"revenue": Decimal("0"), "cost": Decimal("0"), "gross_profit": Decimal("0")}
        )
        for row in rows:
            rep_totals[row.rep]["revenue"] += row.revenue
            rep_totals[row.rep]["cost"] += row.cost
            rep_totals[row.rep]["gross_profit"] += row.gross_profit

        recon_errors = self._reconcile(rows, rep_totals)
        if recon_errors:
            return self._fail(kpi_name, ";".join(recon_errors), as_of=cutoff_utc)

        output_rows = []
        for rep, totals in sorted(rep_totals.items()):
            margin_pct = Decimal("0") if totals["revenue"] == 0 else (totals["gross_profit"] / totals["revenue"])
            output_rows.append(
                {
                    "rep": rep,
                    "revenue_mtd": float(round(totals["revenue"], 2)),
                    "cost_mtd": float(round(totals["cost"], 2)),
                    "gross_profit_mtd": float(round(totals["gross_profit"], 2)),
                    "gross_margin_pct_mtd": float(round(margin_pct, 6)),
                }
            )

        return KpiEnvelope(
            name=kpi_name,
            source_system="acumatica",
            value={
                "rows": output_rows,
                "window_start_utc": month_start_utc.isoformat(),
                "window_end_utc": cutoff_utc.isoformat(),
                "source_endpoint": self.settings.acumatica_ar_invoices_path,
                "source_fields": {
                    "date_field": self.settings.acumatica_financial_date_field,
                    "branch_field": self.settings.acumatica_financial_branch_field,
                    "rep_field": self.settings.acumatica_financial_rep_field,
                    "revenue_field": self.settings.acumatica_financial_revenue_field,
                    "cost_field": self.settings.acumatica_financial_cost_field,
                    "gross_profit_field": self.settings.acumatica_financial_gross_profit_field,
                },
            },
            as_of_timestamp=cutoff_utc,
            freshness_state=FreshnessState.FRESH,
            certification_state=CertificationState.CERTIFIED,
            notes=[
                "Certified from Acumatica only.",
                "Cutoff applied: prior closed day 11:59:59 PM America/New_York.",
                "Tie-out checks passed: extracted totals and branch rollups.",
            ],
        )

    def invoiced_revenue_mtd_by_rep(self) -> KpiEnvelope:
        envelope = self.financial_kpi_payload("Invoiced Revenue MTD by Rep")
        if envelope.value is not None:
            envelope.value["rows"] = [
                {"rep": row["rep"], "revenue_mtd": row["revenue_mtd"]} for row in envelope.value["rows"]
            ]
        return envelope

    def gross_margin_pct_mtd_by_rep(self) -> KpiEnvelope:
        return self.financial_kpi_payload("Gross Margin % MTD by Rep")


def _parse_datetime(value: Any) -> datetime:
    raw = str(value)
    if raw.endswith("Z"):
        raw = raw.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
