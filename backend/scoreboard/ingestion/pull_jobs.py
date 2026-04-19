from dataclasses import dataclass


@dataclass(frozen=True)
class PullJobPlan:
    source: str
    cadence_minutes: int
    todo: str


PULL_JOB_PLANS = [
    PullJobPlan(source="acumatica", cadence_minutes=15, todo="Define scheduler and extraction windows."),
    PullJobPlan(source="pipedrive", cadence_minutes=5, todo="Define scheduler and delta token behavior."),
]
