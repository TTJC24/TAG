from dataclasses import dataclass


@dataclass(frozen=True)
class NormalizationTodo:
    dimension: str
    todo: str


NORMALIZATION_TODOS = [
    NormalizationTodo(dimension="rep", todo="Lock canonical rep mapping across Acumatica and Pipedrive."),
    NormalizationTodo(dimension="branch", todo="Define branch/entity alignment strategy."),
    NormalizationTodo(dimension="customer", todo="Define customer identity match rules."),
]
