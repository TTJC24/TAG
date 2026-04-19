from dataclasses import dataclass


@dataclass(frozen=True)
class NormalizationTodo:
    dimension: str
    todo: str


@dataclass(frozen=True)
class NormalizationScaffold:
    branch_entity_mapping: dict[str, str]
    rep_mapping: dict[str, str]
    stage_include_ids: tuple[str, ...]
    activity_type_include_names: tuple[str, ...]

    def map_branch_to_entity(self, branch_code: str) -> str | None:
        return self.branch_entity_mapping.get(branch_code)

    def rep_mapping_is_provisional(self) -> bool:
        return not bool(self.rep_mapping)

    def include_stage(self, stage_id: str) -> bool:
        if not self.stage_include_ids:
            return True
        return stage_id in self.stage_include_ids

    def include_activity_type(self, activity_type_name: str) -> bool:
        allowed = {name.lower() for name in self.activity_type_include_names}
        if not allowed:
            return False
        return activity_type_name.lower() in allowed


def build_normalization_scaffold(
    branch_entity_mapping: dict[str, str],
    rep_mapping: dict[str, str],
    stage_include_ids: tuple[str, ...],
    activity_type_include_names: tuple[str, ...],
) -> NormalizationScaffold:
    return NormalizationScaffold(
        branch_entity_mapping=branch_entity_mapping,
        rep_mapping=rep_mapping,
        stage_include_ids=stage_include_ids,
        activity_type_include_names=activity_type_include_names,
    )


NORMALIZATION_TODOS = [
    NormalizationTodo(dimension="rep", todo="Rep mapping remains provisional until user-approved mapping is configured."),
    NormalizationTodo(dimension="branch", todo="Branch/entity mapping must be supplied explicitly via configuration."),
    NormalizationTodo(dimension="stages", todo="Stage inclusion is controlled by explicit stage IDs when configured."),
    NormalizationTodo(dimension="activity_types", todo="Activity inclusion is controlled by configured qualifying activity type names."),
]
