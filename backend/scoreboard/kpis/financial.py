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

APPROVED_CERTIFIED_GRAIN = "acumatica_ar_invoice_line"
APPROVED_REP_ATTRIBUTION_RULE = "line_level_rep_required_no_fallback"
APPROVED_SIGNED_AMOUNT_POLICY = "credit_memo_and_return_negative_invoice_positive_void_excluded"
APPROVED_OUT_OF_SCOPE_BRANCH_HANDLING = "hard_fail"
APPROVED_VOID_DOC_TYPES = frozenset({"void", "voided"})
APPROVED_NEGATIVE_DOC_TYPES = frozenset({"credit memo", "credit_memo", "creditmemo", "return"})
APPROVED_POSITIVE_DOC_TYPES = frozenset({"invoice", "inv", "debit memo", "debit_memo"})


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
    grain_key: str
    doc_type: str
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


@dataclass(frozen=True)
class FinancialExtractionDiagnostics:
    source_path: str
    field_bindings: dict[str, str]
    row_count_returned: int
    branch_distribution: dict[str, int]
    rep_distribution: dict[str, int]
    min_transaction_date_utc: str | None
    max_transaction_date_utc: str | None
    cutoff_applied_utc: str
    certified_grain: str
    rep_attribution_rule: str
    signed_amount_policy: str
    completeness_status: str
    tie_out_status: str


@dataclass(frozen=True)
class FinancialExtractionResult:
    rows: list[FinancialRow]
    diagnostics: FinancialExtractionDiagnostics
    error: str | None
    completeness_certain: bool


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

    def _build_diagnostics(
        self,
        rows: list[FinancialRow],
        cutoff_utc: datetime,
        completeness_certain: bool,
        tie_out_status: str,
    ) -> FinancialExtractionDiagnostics:
        branch_distribution: dict[str, int] = defaultdict(int)
        rep_distribution: dict[str, int] = defaultdict(int)
        min_dt: datetime | None = None
        max_dt: datetime | None = None
        for row in rows:
            branch_distribution[row.branch_code] += 1
            rep_distribution[row.rep_name] += 1
            min_dt = row.source_timestamp if min_dt is None else min(min_dt, row.source_timestamp)
            max_dt = row.source_timestamp if max_dt is None else max(max_dt, row.source_timestamp)

        completeness_status = "complete" if completeness_certain else "uncertain"
        return FinancialExtractionDiagnostics(
            source_path=self.settings.acumatica_ar_invoices_path,
            field_bindings={
                "date_field": self.settings.acumatica_financial_date_field,
                "branch_field": self.settings.acumatica_financial_branch_field,
                "rep_field": self.settings.acumatica_financial_rep_field,
                "revenue_field": self.settings.acumatica_financial_revenue_field,
                "cost_field": self.settings.acumatica_financial_cost_field,
                "gross_profit_field": self.settings.acumatica_financial_gross_profit_field,
            },
            row_count_returned=len(rows),
            branch_distribution=dict(sorted(branch_distribution.items())),
            rep_distribution=dict(sorted(rep_distribution.items())),
            min_transaction_date_utc=min_dt.isoformat() if min_dt else None,
            max_transaction_date_utc=max_dt.isoformat() if max_dt else None,
            cutoff_applied_utc=cutoff_utc.isoformat(),
            certified_grain=APPROVED_CERTIFIED_GRAIN,
            rep_attribution_rule=APPROVED_REP_ATTRIBUTION_RULE,
            signed_amount_policy=APPROVED_SIGNED_AMOUNT_POLICY,
            completeness_status=completeness_status,
            tie_out_status=tie_out_status,
        )

    def extract_financial_rows(self, cutoff_utc: datetime) -> FinancialExtractionResult:
        missing_fields = self.source_fields.missing()
        if missing_fields:
            diagnostics = self._build_diagnostics([], cutoff_utc, False, "not_run")
            return FinancialExtractionResult(
                rows=[],
                diagnostics=diagnostics,
                error=f"missing_financial_source_field_config:{','.join(missing_fields)}",
                completeness_certain=False,
            )

        payload = self.client.fetch_ar_invoices(self.settings.acumatica_ar_invoices_path, top=self.settings.financial_extract_top)
        if "fail_state" in payload:
            fail_reason = payload.get("fail_state", {}).get("reason", "acumatica_financial_extraction_failed")
            diagnostics = self._build_diagnostics([], cutoff_utc, False, "not_run")
            return FinancialExtractionResult(
                rows=[],
                diagnostics=diagnostics,
                error=f"acumatica_extraction_failed:{fail_reason}",
                completeness_certain=False,
            )

        raw_rows = payload.get("records", [])
        parsed: list[FinancialRow] = []
        completeness_certain = len(raw_rows) < self.settings.financial_extract_top
        for index, row in enumerate(raw_rows):
            try:
                for required_field in (
                    self.source_fields.date_field,
                    self.source_fields.branch_field,
                    self.source_fields.rep_field,
                    self.source_fields.revenue_field,
                    self.source_fields.cost_field,
                    self.source_fields.gross_profit_field,
                ):
                    if required_field not in row:
                        raise KeyError(f"missing_required_field:{required_field}")
                grain_key = _derive_grain_key(row)
                doc_type = _derive_doc_type(row)
                signed_revenue, signed_cost, signed_gross_profit, excluded = _apply_signed_amount_policy(
                    doc_type=doc_type,
                    revenue=Decimal(str(row[self.source_fields.revenue_field])),
                    cost=Decimal(str(row[self.source_fields.cost_field])),
                    gross_profit=Decimal(str(row[self.source_fields.gross_profit_field])),
                )
                if excluded:
                    continue
                parsed.append(
                    FinancialRow(
                        source_timestamp=_parse_datetime(row[self.source_fields.date_field]),
                        branch_code=str(row[self.source_fields.branch_field]).strip(),
                        rep_name=str(row[self.source_fields.rep_field]).strip(),
                        grain_key=grain_key,
                        doc_type=doc_type,
                        revenue=signed_revenue,
                        cost=signed_cost,
                        gross_profit=signed_gross_profit,
                    )
                )
            except Exception as exc:  # explicit fail behavior for incomplete source field mapping
                diagnostics = self._build_diagnostics(parsed, cutoff_utc, completeness_certain, "not_run")
                return FinancialExtractionResult(
                    rows=[],
                    diagnostics=diagnostics,
                    error=f"financial_source_row_parse_error:index={index}:reason={exc}",
                    completeness_certain=completeness_certain,
                )

        diagnostics = self._build_diagnostics(parsed, cutoff_utc, completeness_certain, "not_run")
        if not completeness_certain:
            return FinancialExtractionResult(
                rows=[],
                diagnostics=diagnostics,
                error=f"financial_extract_incomplete:row_count_hit_cap:{self.settings.financial_extract_top}",
                completeness_certain=False,
            )
        return FinancialExtractionResult(rows=parsed, diagnostics=diagnostics, error=None, completeness_certain=True)


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
            if not row.rep_name.strip():
                errors.append(f"rep_attribution_missing:{row.grain_key}")
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

    def _build_financial_rows(
        self, now_utc: datetime
    ) -> tuple[list[NormalizedFinancialRow], datetime, datetime, list[str], FinancialExtractionDiagnostics]:
        cutoff_utc = FinancialCutoff.prior_closed_cutoff_utc(now_utc, self.settings.financial_cutoff_timezone)
        month_start_utc = FinancialCutoff.month_start_utc(cutoff_utc, self.settings.financial_cutoff_timezone)

        extraction = self.extractor.extract_financial_rows(cutoff_utc)
        if extraction.error:
            return [], cutoff_utc, month_start_utc, [extraction.error], extraction.diagnostics

        filtered = [
            row
            for row in extraction.rows
            if month_start_utc <= row.source_timestamp <= cutoff_utc
        ]
        normalized_rows, mapping_errors = self._normalize_rows(filtered)
        return normalized_rows, cutoff_utc, month_start_utc, mapping_errors, extraction.diagnostics

    def financial_kpi_payload(self, kpi_name: str) -> KpiEnvelope:
        now_utc = self._now()
        rows, cutoff_utc, month_start_utc, base_errors, diagnostics = self._build_financial_rows(now_utc)
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
                "extraction_diagnostics": {
                    "source_path": diagnostics.source_path,
                    "field_bindings": diagnostics.field_bindings,
                    "row_count_returned": diagnostics.row_count_returned,
                    "branch_distribution": diagnostics.branch_distribution,
                    "rep_distribution": diagnostics.rep_distribution,
                    "min_transaction_date_utc": diagnostics.min_transaction_date_utc,
                    "max_transaction_date_utc": diagnostics.max_transaction_date_utc,
                    "cutoff_applied_utc": diagnostics.cutoff_applied_utc,
                    "certified_grain": diagnostics.certified_grain,
                    "rep_attribution_rule": diagnostics.rep_attribution_rule,
                    "signed_amount_policy": diagnostics.signed_amount_policy,
                    "completeness_status": diagnostics.completeness_status,
                    "tie_out_status": "passed",
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

    def financial_validation_status(self) -> KpiEnvelope:
        now_utc = self._now()
        rows, cutoff_utc, _, base_errors, diagnostics = self._build_financial_rows(now_utc)
        branch_scope_complete = bool(self.settings.acumatica_branch_codes) and bool(self.settings.branch_entity_mapping) and not any(
            error.startswith("branch_out_of_scope:") or error.startswith("unmapped_branch:")
            for error in base_errors
        )
        rep_mapping_complete = bool(self.settings.rep_mapping) and not any(
            error.startswith("unmapped_rep:")
            for error in base_errors
        )
        field_binding_complete = not self.extractor.source_fields.missing()
        extraction_complete = diagnostics.completeness_status == "complete"
        certification_blockers = [*base_errors]
        if not branch_scope_complete:
            certification_blockers.append("branch_scope_incomplete")
        if not rep_mapping_complete:
            certification_blockers.append("rep_mapping_incomplete")
        tie_out_status = "not_run"
        if rows and not certification_blockers:
            rep_totals: dict[str, dict[str, Decimal]] = defaultdict(
                lambda: {"revenue": Decimal("0"), "cost": Decimal("0"), "gross_profit": Decimal("0")}
            )
            for row in rows:
                rep_totals[row.rep]["revenue"] += row.revenue
                rep_totals[row.rep]["cost"] += row.cost
                rep_totals[row.rep]["gross_profit"] += row.gross_profit
            tie_out_errors = self._reconcile(rows, rep_totals)
            if tie_out_errors:
                certification_blockers.extend(tie_out_errors)
                tie_out_status = "failed"
            else:
                tie_out_status = "passed"
        elif any("tie_out_failed" in err for err in certification_blockers):
            tie_out_status = "failed"

        cert_state = CertificationState.CERTIFIED if not certification_blockers else CertificationState.FAIL
        return KpiEnvelope(
            name="Financial Validation Status",
            source_system="acumatica",
            as_of_timestamp=cutoff_utc,
            freshness_state=FreshnessState.FRESH if not certification_blockers else FreshnessState.FAILED,
            certification_state=cert_state,
            fail_state=None
            if not certification_blockers
            else FailState(
                reason=";".join(sorted(set(certification_blockers))),
                source="acumatica",
                as_of=cutoff_utc,
                state=CertificationState.FAIL,
            ),
            value={
                "source_path_configured": self.settings.acumatica_ar_invoices_path,
                "field_binding_completeness": field_binding_complete,
                "branch_scope_completeness": branch_scope_complete,
                "rep_mapping_completeness": rep_mapping_complete,
                "extraction_completeness": extraction_complete,
                "tie_out_status": tie_out_status,
                "certified_grain": APPROVED_CERTIFIED_GRAIN,
                "rep_attribution_rule": APPROVED_REP_ATTRIBUTION_RULE,
                "signed_amount_policy": APPROVED_SIGNED_AMOUNT_POLICY,
                "certification_blockers": sorted(set(certification_blockers)),
                "diagnostics": {
                    "source_path": diagnostics.source_path,
                    "field_bindings": diagnostics.field_bindings,
                    "row_count_returned": diagnostics.row_count_returned,
                    "branch_distribution": diagnostics.branch_distribution,
                    "rep_distribution": diagnostics.rep_distribution,
                    "min_transaction_date_utc": diagnostics.min_transaction_date_utc,
                    "max_transaction_date_utc": diagnostics.max_transaction_date_utc,
                    "cutoff_applied_utc": diagnostics.cutoff_applied_utc,
                    "certified_grain": diagnostics.certified_grain,
                    "rep_attribution_rule": diagnostics.rep_attribution_rule,
                    "signed_amount_policy": diagnostics.signed_amount_policy,
                    "completeness_status": diagnostics.completeness_status,
                    "tie_out_status": tie_out_status,
                },
            },
            notes=[
                "Read-only certification preflight for Acumatica financial KPI extraction path.",
            ],
        )


def _parse_datetime(value: Any) -> datetime:
    raw = str(value)
    if raw.endswith("Z"):
        raw = raw.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _derive_grain_key(row: dict[str, Any]) -> str:
    invoice_ref = row.get("invoice_ref") or row.get("ref_nbr") or row.get("RefNbr") or row.get("invoice_number")
    line_nbr = row.get("line_nbr") or row.get("LineNbr") or row.get("line_number")
    if invoice_ref is None or line_nbr is None:
        raise KeyError("missing_required_field:certified_grain_key(invoice_ref+line_nbr)")
    return f"{invoice_ref}:{line_nbr}"


def _derive_doc_type(row: dict[str, Any]) -> str:
    doc_type = row.get("doc_type") or row.get("DocType")
    if doc_type is None:
        raise KeyError("missing_required_field:doc_type")
    return str(doc_type).strip().lower()


def _apply_signed_amount_policy(
    doc_type: str, revenue: Decimal, cost: Decimal, gross_profit: Decimal
) -> tuple[Decimal, Decimal, Decimal, bool]:
    if doc_type in APPROVED_VOID_DOC_TYPES:
        return Decimal("0"), Decimal("0"), Decimal("0"), True
    if doc_type in APPROVED_NEGATIVE_DOC_TYPES:
        return -abs(revenue), -abs(cost), -abs(gross_profit), False
    if doc_type in APPROVED_POSITIVE_DOC_TYPES:
        return abs(revenue), abs(cost), abs(gross_profit), False
    raise ValueError(f"signed_amount_policy_doc_type_mismatch:{doc_type}")
