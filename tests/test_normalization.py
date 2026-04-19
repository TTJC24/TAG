from backend.scoreboard.normalization.mapper import build_normalization_scaffold


def test_normalization_mapping_config_behavior():
    scaffold = build_normalization_scaffold(
        branch_entity_mapping={"B1": "FS"},
        rep_mapping={},
        stage_include_ids=("1", "2"),
        activity_type_include_names=("face-to-face meeting", "jobsite visit"),
    )

    assert scaffold.map_branch_to_entity("B1") == "FS"
    assert scaffold.map_branch_to_entity("B9") is None
    assert scaffold.rep_mapping_is_provisional() is True


def test_stage_and_activity_filtering():
    scaffold = build_normalization_scaffold(
        branch_entity_mapping={},
        rep_mapping={},
        stage_include_ids=("10",),
        activity_type_include_names=("other meeting",),
    )

    assert scaffold.include_stage("10") is True
    assert scaffold.include_stage("11") is False
    assert scaffold.include_activity_type("Other Meeting") is True
    assert scaffold.include_activity_type("call") is False
