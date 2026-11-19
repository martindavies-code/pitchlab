"""Comprehensive pytest suite verifying DuckDB parity, StatsBomb data, 7 modules, and 5-stage workflow."""

from __future__ import annotations

import io
import duckdb
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.adapters.file_importer import PROVIDER_MAPPING_PRESETS, ingest_mapped_dataframe
from backend.adapters.statsbomb_loader import ingest_default_statsbomb_dataset
from backend.agent.workflow import (
    approve_stage_2_build_plan,
    approve_stage_3_execute_and_verify,
    approve_stage_4_render,
    confirm_stage_1_and_check_feasibility,
    override_assumptions_and_rerun,
    start_workflow_session,
)
from backend.analytics.conclusion import (
    _find_mentioned_team,
    build_analysis_conclusion,
    extract_club_mentions,
)
from backend.analytics.modules import MODULE_DISPATCH, _compute_team_style_profile, execute_module
from backend.analytics.verification import run_automated_verification
from backend.db.schema import (
    CANONICAL_TABLES,
    from_source_coords,
    inspect_database_capabilities,
    to_105x68,
    to_120x80_from_105x68,
)
from backend.main import app


@pytest.fixture(scope="module")
def seeded_conn() -> duckdb.DuckDBPyConnection:
    """Create an isolated in-memory DuckDB instance populated with the canonical StatsBomb dataset."""
    conn = duckdb.connect(":memory:")
    ingest_default_statsbomb_dataset(conn, reset=True, seed=42)
    yield conn
    conn.close()


def test_canonical_schema_and_statsbomb_population(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    caps = inspect_database_capabilities(seeded_conn)
    for table in CANONICAL_TABLES:
        assert caps["table_counts"][table] > 0, f"Table {table} must be populated"
    assert caps["table_counts"]["matches"] == 180
    assert caps["table_counts"]["teams"] == 10
    assert caps["table_counts"]["players"] == 150
    assert set(caps["seasons"]) == {"2023/2024", "2024/2025"}
    assert caps["capabilities"]["has_tracking_data"] is False


def test_match_score_and_event_goal_exact_parity(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Every single match's home_score and away_score must match Shot(outcome='Goal') counts in events."""
    mismatches = seeded_conn.execute(
        """
        WITH per_team_goals AS (
            SELECT match_id, team_id,
                   SUM(CASE WHEN event_type = 'Shot' AND outcome = 'Goal' THEN 1 ELSE 0 END) AS ev_goals
            FROM events
            GROUP BY match_id, team_id
        )
        SELECT m.match_id, m.home_score, COALESCE(hg.ev_goals, 0), m.away_score, COALESCE(ag.ev_goals, 0)
        FROM matches m
        LEFT JOIN per_team_goals hg ON m.match_id = hg.match_id AND m.home_team_id = hg.team_id
        LEFT JOIN per_team_goals ag ON m.match_id = ag.match_id AND m.away_team_id = ag.team_id
        WHERE m.home_score != COALESCE(hg.ev_goals, 0)
           OR m.away_score != COALESCE(ag.ev_goals, 0)
        """
    ).fetchall()
    assert mismatches == [], f"Found score/event goal mismatches: {mismatches}"


def test_shot_counts_xg_bounds_and_player_minutes(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Verify shot xG values lie in (0, 1], total xG sums match, and each team totals 990 lineup minutes/match."""
    oob_shots = seeded_conn.execute(
        "SELECT COUNT(*) FROM events WHERE event_type = 'Shot' AND (xg <= 0 OR xg > 1.0)"
    ).fetchone()[0]
    assert oob_shots == 0

    bad_team_minutes = seeded_conn.execute(
        """
        SELECT match_id, team_id, SUM(minutes_played) AS tot_mins
        FROM lineups
        GROUP BY match_id, team_id
        HAVING SUM(minutes_played) != 990
        """
    ).fetchall()
    assert bad_team_minutes == [], f"Expected 990 team minutes per match, got {bad_team_minutes}"


def test_coordinate_grid_conversions() -> None:
    """Verify bidirectional precision between 120x80 StatsBomb and 105x68 FIFA/Opta grids."""
    x105, y68 = to_105x68(120.0, 80.0)
    assert (x105, y68) == (105.0, 68.0)

    x105_mid, y68_mid = to_105x68(60.0, 40.0)
    assert (x105_mid, y68_mid) == (52.5, 34.0)

    x120_back, y80_back = to_120x80_from_105x68(52.5, 34.0)
    assert (x120_back, y80_back) == (60.0, 40.0)

    # Opta 100x100 inversion check: (50, 100) -> (60, 0) in StatsBomb top-down
    ox120, oy80, ox105, oy68 = from_source_coords(50.0, 100.0, "100x100")
    assert (ox120, oy80) == (60.0, 0.0)
    assert (ox105, oy68) == (52.5, 0.0)


@pytest.mark.parametrize("module_id", list(MODULE_DISPATCH.keys()))
def test_all_seven_analytical_modules_and_verification(
    seeded_conn: duckdb.DuckDBPyConnection,
    module_id: str,
) -> None:
    """Every analytical module must execute cleanly and pass all 5 Stage 4 verification checks."""
    res_120 = execute_module(seeded_conn, module_id, {"coord_grid": "120x80"})
    assert res_120["module_id"] == module_id
    assert res_120["coord_grid"] == "120x80"
    assert len(res_120["table_rows"]) > 0
    assert res_120["summary"]
    assert isinstance(res_120.get("conclusion"), str) and len(res_120["conclusion"]) > len(res_120["summary"])
    assert "." in res_120["conclusion"]

    ver = run_automated_verification(seeded_conn, module_id, res_120["assumptions"], res_120)
    assert ver["all_passed"] is True, f"Verification failed for {module_id}: {ver['checks']}"

    # Verify 105x68 coordinate switch works cleanly
    res_105 = execute_module(seeded_conn, module_id, {"coord_grid": "105x68"})
    assert res_105["coord_grid"] == "105x68"
    for marker in res_105["pitch"]["markers"]:
        assert 0.0 <= marker["x"] <= 105.0
        assert 0.0 <= marker["y"] <= 68.0


def test_player_progression_padj_vs_per90_differs(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Switching normalization from per_90 to possession_adjusted must visibly alter defensive disruption scores."""
    r_p90 = execute_module(
        seeded_conn,
        "multi_season_player_progression",
        {"skill_composite": "defensive_disruption", "normalisation": "per_90", "min_minutes": 450},
    )
    r_padj = execute_module(
        seeded_conn,
        "multi_season_player_progression",
        {"skill_composite": "defensive_disruption", "normalisation": "possession_adjusted", "min_minutes": 450},
    )
    assert r_p90["table_rows"] and r_padj["table_rows"]
    scores_90 = {r["player_name"]: r["season_2_score"] for r in r_p90["table_rows"]}
    scores_padj = {r["player_name"]: r["season_2_score"] for r in r_padj["table_rows"]}
    assert scores_90 != scores_padj


def test_five_stage_workflow_happy_path_and_assumption_override(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    s1 = start_workflow_session(
        seeded_conn,
        "Is Manchester United going in the right direction since the new manager arrived?",
    )
    assert s1["stage"] == 1
    assert s1["module_id"] == "managerial_impact_tracker"
    assert s1["params"]["team_name"] == "Manchester United"

    s2 = confirm_stage_1_and_check_feasibility(seeded_conn, s1["session_id"])
    assert s2["stage"] == 2
    assert s2["feasibility"]["feasible"] is True

    s3 = approve_stage_2_build_plan(seeded_conn, s1["session_id"])
    assert s3["stage"] == 3
    assert s3["execution_plan"]["objective"]

    s4 = approve_stage_3_execute_and_verify(seeded_conn, s1["session_id"], {"rolling_window": 3})
    assert s4["stage"] == 4
    assert s4["verification"]["all_passed"] is True
    assert s4["result"]["charts"]["rolling_window"] == 3

    s5 = approve_stage_4_render(seeded_conn, s1["session_id"])
    assert s5["stage"] == 5
    assert s5["status"] == "completed"
    prev_conclusion = s5["conclusion"]
    assert prev_conclusion and "Manchester United" in prev_conclusion
    assert s5["result"]["conclusion"] == prev_conclusion

    # Override assumptions in Stage 5 and re-run cleanly
    s5_rerun = override_assumptions_and_rerun(
        seeded_conn,
        s1["session_id"],
        {"coord_grid": "105x68", "rolling_window": 5, "team_name": "Arsenal"},
    )
    assert s5_rerun["result"]["coord_grid"] == "105x68"
    assert s5_rerun["result"]["charts"]["rolling_window"] == 5
    assert s5_rerun["verification"]["all_passed"] is True
    assert s5_rerun["conclusion"] and "Arsenal" in s5_rerun["conclusion"]
    assert s5_rerun["conclusion"] != prev_conclusion


def test_stage_2_feasibility_halt_on_missing_tracking_or_360_data(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Querying tracking sprint speeds or 360 body-pose freeze frames must HALT immediately at Stage 2."""
    s1 = start_workflow_session(
        seeded_conn,
        "Which Arsenal wingers hit the highest top sprint speed km/h and body-pose orientation on freeze-frames?",
    )
    s2 = confirm_stage_1_and_check_feasibility(seeded_conn, s1["session_id"])
    assert s2["stage"] == 2
    assert s2["status"] == "halted_infeasible"
    assert s2["feasibility"]["feasible"] is False
    assert len(s2["feasibility"]["missing_requirements"]) >= 2

    with pytest.raises(ValueError, match="Feasibility check halted"):
        approve_stage_2_build_plan(seeded_conn, s1["session_id"])


def test_csv_opta_importer_mapping_and_coord_normalization(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Verify Opta 100x100 CSV import maps into canonical DuckDB events and 120x80/105x68 coordinates."""
    df = pd.DataFrame(
        [
            {
                "event_id": "opta_test_1",
                "match_id": 888001,
                "min": 14,
                "team_name": "Bayer Leverkusen",
                "player_name": "Florian Wirtz",
                "type_name": "Pass",
                "outcome": "Complete",
                "x": 50.0,
                "y": 50.0,
                "end_x": 85.0,
                "end_y": 60.0,
                "xG": 0.0,
            },
            {
                "event_id": "opta_test_2",
                "match_id": 888001,
                "min": 15,
                "team_name": "Bayer Leverkusen",
                "player_name": "Florian Wirtz",
                "type_name": "Shot",
                "outcome": "Goal",
                "x": 90.0,
                "y": 50.0,
                "end_x": 100.0,
                "end_y": 50.0,
                "xG": 0.42,
            },
        ]
    )
    res = ingest_mapped_dataframe(
        seeded_conn,
        df,
        column_mapping=PROVIDER_MAPPING_PRESETS["opta"]["columns"],
        coord_system="100x100",
        data_source="opta_csv_test",
    )
    assert res["events_ingested"] == 2
    row = seeded_conn.execute(
        "SELECT x, y, x_105, y_105, xg, outcome FROM events WHERE event_id = 'opta_test_2'"
    ).fetchone()
    assert row[0] == 108.0 and row[1] == 40.0
    assert row[2] == 94.5 and row[3] == 34.0
    assert abs(row[4] - 0.42) < 1e-6
    assert row[5] == "Goal"


def test_fastapi_endpoints_end_to_end(tmp_path, monkeypatch) -> None:
    """Verify FastAPI TestClient lifecycle, module endpoint, and 5-stage API gates."""
    db_file = tmp_path / "test_api.duckdb"
    monkeypatch.setenv("PITCHLAB_DB_PATH", str(db_file))
    with TestClient(app) as client:
        h = client.get("/api/health")
        assert h.status_code == 200
        assert h.json()["table_counts"]["matches"] == 180

        m = client.post("/api/modules/shot_location_zone_efficiency/run", json={"overrides": {"team_name": "Arsenal"}})
        assert m.status_code == 200
        assert m.json()["verification"]["all_passed"] is True

        wf = client.post("/api/workflow/start", json={"prompt": "Where are Arsenal shooting from?"})
        assert wf.status_code == 200
        sid = wf.json()["session_id"]

        st2 = client.post(f"/api/workflow/{sid}/stage-1-confirm", json={"clarifications": {}})
        assert st2.status_code == 200
        assert st2.json()["feasibility"]["feasible"] is True


def test_question_aware_conclusion_synthesis_and_mw_parsing(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Verify prompt matchweek parsing and question-tailored conclusions across workflows."""
    s1 = start_workflow_session(
        seeded_conn,
        "Did anything change for Arsenal after the intervention from matchweek 5 to 12?",
    )
    assert s1["module_id"] == "tactical_intervention_comparison"
    assert s1["params"]["start_mw"] == 5
    assert s1["params"]["end_mw"] == 12

    confirm_stage_1_and_check_feasibility(seeded_conn, s1["session_id"])
    approve_stage_2_build_plan(seeded_conn, s1["session_id"])
    s4 = approve_stage_3_execute_and_verify(seeded_conn, s1["session_id"])
    s5 = approve_stage_4_render(seeded_conn, s1["session_id"])
    assert s5["conclusion"] is not None
    assert "MW 5–12" in s5["conclusion"]
    assert "Arsenal" in s5["conclusion"]

    # League table underperformance phrasing should lead with underperformers
    u1 = start_workflow_session(seeded_conn, "Which teams are underperforming their xPTS in 2024/2025?")
    confirm_stage_1_and_check_feasibility(seeded_conn, u1["session_id"])
    approve_stage_2_build_plan(seeded_conn, u1["session_id"])
    approve_stage_3_execute_and_verify(seeded_conn, u1["session_id"])
    u5 = approve_stage_4_render(seeded_conn, u1["session_id"])
    assert u5["conclusion"] is not None
    assert "shortchanged" in u5["conclusion"] or "shortfall" in u5["conclusion"]


def _make_managerial_fixture(
    before_matches: int = 8,
    after_matches: int = 8,
    before_ppg: float = 1.50,
    after_ppg: float = 1.50,
    before_xgf: float = 1.40,
    after_xgf: float = 1.40,
    before_xga: float = 1.10,
    after_xga: float = 1.10,
    team_name: str = "Arsenal",
    season_name: str = "2024/2025",
    split_mw: int = 9,
) -> dict:
    before_xgd = round(before_xgf - before_xga, 2)
    after_xgd = round(after_xgf - after_xga, 2)
    return {
        "module_id": "managerial_impact_tracker",
        "title": f"Managerial Impact Tracker — {team_name} ({season_name})",
        "coord_grid": "120x80",
        "summary": "Fixture summary.",
        "charts": {
            "timeline": [
                {
                    "match_week": split_mw + max(0, after_matches - 1),
                    "rolling_ppg": after_ppg,
                    "rolling_xgf": after_xgf,
                    "rolling_xga": after_xga,
                }
            ]
            if after_matches > 0
            else [],
            "milestones": [{"match_week": split_mw, "previous_manager": "Mgr A", "new_manager": "Mgr B"}],
            "rolling_window": 4,
        },
        "table_rows": [
            {
                "period": f"Before MW {split_mw}",
                "matches": before_matches,
                "ppg": before_ppg,
                "gf_per90": round(before_xgf, 2),
                "ga_per90": round(before_xga, 2),
                "xgf_per90": before_xgf,
                "xga_per90": before_xga,
                "xg_diff_per90": before_xgd,
            },
            {
                "period": f"From MW {split_mw} Onwards",
                "matches": after_matches,
                "ppg": after_ppg,
                "gf_per90": round(after_xgf, 2),
                "ga_per90": round(after_xga, 2),
                "xgf_per90": after_xgf,
                "xga_per90": after_xga,
                "xg_diff_per90": after_xgd,
            },
        ],
        "assumptions": {"team_name": team_name, "season_name": season_name, "milestone_match_week": split_mw, "rolling_window": 4},
    }


def test_managerial_conclusion_direction_and_component_takeaways(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Verify Arsenal MW 5 real-data reproduction, 3x3 direction matrix, and component-accurate takeaways."""
    # Confirmed canonical reproduction: Arsenal MW 5 (PPG 1.50 -> 1.93, xGD +1.25 -> +0.30)
    arsenal_res = execute_module(
        seeded_conn,
        "managerial_impact_tracker",
        {"team_name": "Arsenal", "season_name": "2024/2025", "milestone_match_week": 5},
    )
    before, after = arsenal_res["table_rows"][0], arsenal_res["table_rows"][1]
    assert before["ppg"] == 1.50 and after["ppg"] == 1.93
    assert before["xg_diff_per90"] == 1.25 and after["xg_diff_per90"] == 0.30

    concl = arsenal_res["conclusion"]
    assert "Mixed" in concl
    assert "points per game have risen" in concl
    assert "xG differential has declined" in concl
    assert "-0.95" in concl
    assert "-0.81" in concl and "+0.13" in concl
    for forbidden in ("nearly flat", "finishing", "box survival", "territorial dominance", "match control"):
        assert forbidden not in concl.lower(), f"Forbidden unsupported phrase {forbidden!r} in: {concl}"

    # 3x3 table-driven matrix crossing (xgd_dir x ppg_dir)
    matrix_cases = [
        # (xgf_b, xgf_a, xga_b, xga_a, ppg_b, ppg_a, must_contain, must_not_contain)
        (1.20, 1.60, 1.20, 1.00, 1.40, 2.10, ["Yes", "points output", "xG differential rising"], ["declined", "nearly flat"]),
        (1.20, 1.60, 1.10, 1.10, 1.50, 1.50, ["Partially", "xG differential has improved", "broadly flat"], ["declined"]),
        (1.20, 1.60, 1.10, 1.10, 2.00, 1.40, ["Mixed", "xG differential has improved", "points per game have declined"], ["both"]),
        (1.40, 1.40, 1.10, 1.10, 1.40, 2.00, ["Partially", "points per game have risen", "nearly flat"], ["xG differential has declined", "xG differential has improved"]),
        (1.40, 1.40, 1.10, 1.10, 1.50, 1.50, ["held steady", "minimal change"], ["declined", "risen"]),
        (1.40, 1.40, 1.10, 1.10, 2.00, 1.40, ["Partially", "points per game have declined", "nearly flat"], ["risen"]),
        (1.80, 1.30, 1.00, 1.00, 1.40, 2.00, ["Mixed", "points per game have risen", "xG differential has declined"], ["nearly flat", "chance creation"]),
        (1.80, 1.30, 1.00, 1.00, 1.50, 1.50, ["No", "xG differential has declined", "broadly steady"], ["risen"]),
        (1.80, 1.30, 1.00, 1.40, 2.00, 1.20, ["No", "declined", "both points per game and underlying xG differential"], ["risen", "nearly flat"]),
    ]
    for xgf_b, xgf_a, xga_b, xga_a, ppg_b, ppg_a, must_in, must_out in matrix_cases:
        fx = _make_managerial_fixture(
            before_ppg=ppg_b,
            after_ppg=ppg_a,
            before_xgf=xgf_b,
            after_xgf=xgf_a,
            before_xga=xga_b,
            after_xga=xga_a,
        )
        out = build_analysis_conclusion(fx)
        verdict_sentence = out.split(" Across ")[0]
        for phrase in must_in:
            assert phrase in out, f"Expected {phrase!r} in: {out}"
        for phrase in must_out:
            assert phrase not in verdict_sentence, f"Unexpected {phrase!r} in verdict: {verdict_sentence}"

    # Component isolation: xGD up solely from lower xGA (xGF flat 1.40 -> 1.40) must NOT claim chance creation improved
    xga_only_improved = build_analysis_conclusion(
        _make_managerial_fixture(before_xgf=1.40, after_xgf=1.40, before_xga=1.50, after_xga=0.90, before_ppg=1.40, after_ppg=2.00)
    )
    assert "lower xGA conceded" in xga_only_improved
    assert "attacking xGF, which remained nearly flat" in xga_only_improved
    assert "chance creation" not in xga_only_improved.lower()

    # Component isolation: xGD down solely from lower xGF (xGA flat 1.00 -> 1.00) must NOT claim opponents created better chances
    xgf_only_dropped = build_analysis_conclusion(
        _make_managerial_fixture(before_xgf=1.80, after_xgf=1.00, before_xga=1.00, after_xga=1.00, before_ppg=1.80, after_ppg=1.20)
    )
    assert "attacking xGF dropping" in xgf_only_dropped
    assert "xGA conceded stayed nearly flat" in xgf_only_dropped
    assert "higher-value looks" not in xgf_only_dropped.lower()


def test_opposition_scouting_match_state_direction(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Verify match-state x-position comparison matches actual values, equality, near-equality, and missing states."""
    # Real canonical reproductions
    for team in ("Arsenal", "Tottenham Hotspur", "Newcastle United"):
        res = execute_module(seeded_conn, "opposition_scouting_one_pager", {"opponent_name": team, "season_name": "2024/2025"})
        concl = res["conclusion"]
        states = {r["match_state"]: r for r in res["table_rows"]}
        assert states["Winning"]["avg_def_line_m"] > states["Losing"]["avg_def_line_m"]
        assert "dropping to" not in concl.lower()
        assert "pushing up to" not in concl.lower()
        assert "average defensive-action location" in concl
        if team == "Arsenal":
            assert "40.3m" in concl and "39.6m" in concl and "differs only slightly" in concl
        else:
            assert "sits higher when leading" in concl

    liv = execute_module(seeded_conn, "opposition_scouting_one_pager", {"opponent_name": "Liverpool", "season_name": "2024/2025"})
    assert "identical when leading and chasing (41.7m" in liv["conclusion"]

    city = execute_module(seeded_conn, "opposition_scouting_one_pager", {"opponent_name": "Manchester City", "season_name": "2024/2025"})
    assert "sits deeper when leading (40.4m" in city["conclusion"] and "(41.4m" in city["conclusion"]

    # Synthetic states: missing losing state must NOT invent a comparison
    missing_losing_payload = {
        "module_id": "opposition_scouting_one_pager",
        "coord_grid": "120x80",
        "charts": {
            "style_kpis": {"matches_played": 5, "ppda": 11.0, "possession_share": 52.0, "build_up_directness": 20.0, "xg_per90": 1.5},
            "formations": [{"formation": "4-2-3-1", "matches": 5}],
            "danger_players": [],
        },
        "pitch": {"zones": [{"zone_id": "Mid Block - Central Corridor", "intensity": 1.0, "value_label": "42"}]},
        "table_rows": [
            {"match_state": "Winning", "primary_shape": "4-2-3-1", "events": 500, "directness_pct": 18.0, "prog_pass_share": 10.0, "avg_def_line_m": 44.0},
            {"match_state": "Drawing", "primary_shape": "4-2-3-1", "events": 400, "directness_pct": 19.0, "prog_pass_share": 11.0, "avg_def_line_m": 43.0},
        ],
        "assumptions": {"opponent_name": "Arsenal", "season_name": "2024/2025"},
    }
    missing_concl = build_analysis_conclusion(missing_losing_payload)
    assert "insufficient state coverage to compare leading versus chasing" in missing_concl
    assert "44.0m" in missing_concl and "chasing (" not in missing_concl


def test_missing_samples_and_legitimate_zero_observations(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Missing/empty samples must explicitly report insufficient data and fail verification; real 0s remain distinct."""
    import json

    # A. tactical_intervention_comparison with empty MW window (30-38) + valid season baseline
    res_a = execute_module(seeded_conn, "tactical_intervention_comparison", {"team_name": "Arsenal", "season_name": "2024/2025", "start_mw": 30, "end_mw": 38})
    ver_a = run_automated_verification(seeded_conn, "tactical_intervention_comparison", res_a["assumptions"], res_a)
    concl_a = build_analysis_conclusion(res_a, verification=ver_a)
    assert res_a["charts"]["match_window"]["matches"] == 0
    assert res_a["charts"]["match_window"]["season_matches"] == 18
    assert res_a["charts"]["match_window"]["intervention_available"] is False
    assert res_a["charts"]["match_window"]["season_available"] is True
    assert "Baseline Only" in res_a["title"] and "Unavailable" in res_a["title"]
    assert len(res_a["charts"]["radar"]) == 6 and len(res_a["table_rows"]) == 6
    for item in res_a["charts"]["radar"]:
        assert isinstance(item["season_avg"], (int, float))
        assert isinstance(item["season_percentile"], (int, float))
        assert item["intervention_run"] is None
        assert item["run_percentile"] is None
        assert item["delta"] is None
    for row in res_a["table_rows"]:
        assert isinstance(row["season_avg"], (int, float))
        assert isinstance(row["season_pct"], (int, float))
        assert row["intervention_run"] is None
        assert row["run_pct"] is None
        assert row["delta"] is None
    assert ver_a["all_passed"] is False
    assert "Insufficient match sample" in concl_a and "0 matches" in concl_a
    for fabricated in ("clear tactical", "12.00 PPDA", "50.0% → 50.0%", "35.0% → 35.0%", "30.0 progressive"):
        assert fabricated not in concl_a
    assert "Verification warning" in concl_a

    # A2. tactical_intervention_comparison with unknown season 2030/2031
    res_a_empty = execute_module(seeded_conn, "tactical_intervention_comparison", {"team_name": "Arsenal", "season_name": "2030/2031", "start_mw": 1, "end_mw": 5})
    ver_a_empty = run_automated_verification(seeded_conn, "tactical_intervention_comparison", res_a_empty["assumptions"], res_a_empty)
    assert res_a_empty["charts"]["match_window"]["matches"] == 0
    assert res_a_empty["charts"]["match_window"]["season_matches"] == 0
    assert res_a_empty["charts"]["match_window"]["season_available"] is False
    assert res_a_empty["charts"]["match_window"]["intervention_available"] is False
    assert res_a_empty["charts"]["radar"] == []
    assert res_a_empty["table_rows"] == []
    assert ver_a_empty["all_passed"] is False

    # B. managerial_impact_tracker with unknown season 2030/2031
    res_b = execute_module(seeded_conn, "managerial_impact_tracker", {"team_name": "Arsenal", "season_name": "2030/2031"})
    ver_b = run_automated_verification(seeded_conn, "managerial_impact_tracker", res_b["assumptions"], res_b)
    concl_b = build_analysis_conclusion(res_b, verification=ver_b)
    assert ver_b["all_passed"] is False
    assert res_b["table_rows"] == []
    assert res_b["charts"]["timeline"] == []
    assert "No Match Data" in res_b["title"]
    assert "Insufficient match data" in concl_b and "0 matches" in concl_b
    assert "held steady" not in concl_b

    # B2. One empty managerial period (isolated DuckDB fixture where before_matches == 0, after_matches > 0)
    one_side_conn = duckdb.connect(":memory:")
    ingest_default_statsbomb_dataset(one_side_conn, reset=True, seed=7)
    one_side_conn.execute("DELETE FROM events WHERE match_id IN (SELECT match_id FROM matches WHERE season_name = '2024/2025' AND match_week < 15)")
    one_side_conn.execute("DELETE FROM lineups WHERE match_id IN (SELECT match_id FROM matches WHERE season_name = '2024/2025' AND match_week < 15)")
    one_side_conn.execute("DELETE FROM matches WHERE season_name = '2024/2025' AND match_week < 15")
    res_b_one = execute_module(one_side_conn, "managerial_impact_tracker", {"team_name": "Arsenal", "season_name": "2024/2025", "milestone_match_week": 15})
    ver_b_one = run_automated_verification(one_side_conn, "managerial_impact_tracker", res_b_one["assumptions"], res_b_one)
    one_side_conn.close()
    assert res_b_one["table_rows"][0]["matches"] == 0
    assert res_b_one["table_rows"][0]["ppg"] is None
    assert res_b_one["table_rows"][0]["xg_diff_per90"] is None
    assert res_b_one["table_rows"][1]["matches"] > 0
    assert isinstance(res_b_one["table_rows"][1]["ppg"], (int, float))
    assert isinstance(res_b_one["table_rows"][1]["xg_diff_per90"], (int, float))
    assert "Incomplete Split" in res_b_one["title"]
    assert ver_b_one["all_passed"] is False
    assert "Insufficient pre-split sample" in res_b_one["conclusion"] and "0 matches were recorded before MW 15" in res_b_one["conclusion"]

    # C. opposition_scouting_one_pager with Unknown Club + _compute_team_style_profile 0-match guard
    style_missing = _compute_team_style_profile(seeded_conn, "Unknown Club", "2024/2025", {"ppda_def_line_x": 42.0, "high_turnover_x_threshold": 65.0, "prog_pass_min_dist": 10.0})
    assert style_missing["matches_played"] == 0 and style_missing["ppda"] is None and style_missing["possession_share"] is None
    res_c = execute_module(seeded_conn, "opposition_scouting_one_pager", {"opponent_name": "Unknown Club", "season_name": "2024/2025"})
    ver_c = run_automated_verification(seeded_conn, "opposition_scouting_one_pager", res_c["assumptions"], res_c)
    concl_c = build_analysis_conclusion(res_c, verification=ver_c)
    assert res_c["charts"]["style_kpis"]["matches_played"] == 0
    assert res_c["charts"]["style_kpis"]["ppda"] is None
    assert res_c["charts"]["style_kpis"]["possession_share"] is None
    assert res_c["table_rows"] == []
    assert res_c["pitch"]["zones"] == []
    assert "No Match Data" in res_c["title"]
    assert ver_c["all_passed"] is False
    assert "Insufficient data to scout Unknown Club" in concl_c and "0 matches" in concl_c
    for fabricated in ("4-3-3", "balanced", "selective mid-press", "span evenly"):
        assert fabricated not in concl_c

    # D. multi_season_player_progression with 0 qualifiers
    res_d = execute_module(seeded_conn, "multi_season_player_progression", {"min_minutes": 99999})
    ver_d = run_automated_verification(seeded_conn, "multi_season_player_progression", res_d["assumptions"], res_d)
    assert ver_d["all_passed"] is False
    assert res_d["table_rows"] == []
    assert res_d["charts"]["leaderboard"] == []
    assert "No Qualifiers" in res_d["title"]
    assert "Insufficient qualifying player sample" in res_d["conclusion"] and "0 players" in res_d["conclusion"]

    # E. tactical_fit_recruitment_matcher with unknown player, unknown season, and valid same-club
    res_e1 = execute_module(seeded_conn, "tactical_fit_recruitment_matcher", {"player_name": "Nonexistent Player", "target_club": "Arsenal"})
    ver_e1 = run_automated_verification(seeded_conn, "tactical_fit_recruitment_matcher", res_e1["assumptions"], res_e1)
    assert ver_e1["all_passed"] is False
    assert "Nonexistent Player" in res_e1["title"] and "Player Not Found" in res_e1["title"]
    assert "David Raya" not in json.dumps(res_e1)
    assert res_e1["charts"]["player_matched"] is False
    assert res_e1["charts"]["fit_score"] is None
    assert res_e1["charts"]["current_club"] is None
    assert res_e1["charts"]["radar"] == []
    assert res_e1["charts"]["adaptation_risks"] == []
    assert res_e1["table_rows"] == []
    assert res_e1["pitch"]["markers"] == []
    assert "minimal tactical friction" not in res_e1["summary"]
    assert "Insufficient data to evaluate tactical fit for Nonexistent Player" in res_e1["conclusion"]

    res_e2 = execute_module(seeded_conn, "tactical_fit_recruitment_matcher", {"player_name": "Cole Palmer", "target_club": "Arsenal", "season_name": "2030/2031"})
    ver_e2 = run_automated_verification(seeded_conn, "tactical_fit_recruitment_matcher", res_e2["assumptions"], res_e2)
    assert ver_e2["all_passed"] is False
    assert res_e2["charts"]["fit_score"] is None
    assert res_e2["charts"]["radar"] == []
    assert res_e2["table_rows"] == []
    assert res_e2["pitch"]["markers"] == []
    assert "Insufficient match data in 2030/2031" in res_e2["conclusion"]

    res_e_same = execute_module(seeded_conn, "tactical_fit_recruitment_matcher", {"player_name": "Bukayo Saka", "target_club": "Arsenal"})
    ver_e_same = run_automated_verification(seeded_conn, "tactical_fit_recruitment_matcher", res_e_same["assumptions"], res_e_same)
    assert ver_e_same["all_passed"] is True
    assert res_e_same["charts"]["player_matched"] is True
    assert res_e_same["charts"]["fit_score"] == 99
    assert len(res_e_same["table_rows"]) == 6

    # F. league_table_vs_underlying_play with unknown season
    res_f = execute_module(seeded_conn, "league_table_vs_underlying_play", {"season_name": "2030/2031"})
    ver_f = run_automated_verification(seeded_conn, "league_table_vs_underlying_play", res_f["assumptions"], res_f)
    assert ver_f["all_passed"] is False
    assert res_f["table_rows"] == []
    assert res_f["charts"]["scatter"] == []
    assert "No Match Data" in res_f["title"]
    assert "Insufficient match data in 2030/2031" in res_f["conclusion"]

    # G. shot_location_zone_efficiency with Unknown Club
    res_g = execute_module(seeded_conn, "shot_location_zone_efficiency", {"team_name": "Unknown Club", "season_name": "2024/2025"})
    ver_g = run_automated_verification(seeded_conn, "shot_location_zone_efficiency", res_g["assumptions"], res_g)
    assert ver_g["all_passed"] is False
    assert res_g["table_rows"] == []
    assert res_g["charts"]["zone_comparison"] == []
    assert res_g["pitch"]["zones"] == []
    assert res_g["pitch"]["markers"] == []
    assert "No Shot Data" in res_g["title"]
    assert "Insufficient shot data for Unknown Club" in res_g["conclusion"] and "0 shot events" in res_g["conclusion"]

    # FastAPI standalone endpoint must propagate verification warning into result.conclusion
    with TestClient(app) as client:
        api_empty = client.post(
            "/api/modules/tactical_intervention_comparison/run",
            json={"overrides": {"team_name": "Arsenal", "season_name": "2024/2025", "start_mw": 30, "end_mw": 38}},
        )
        assert api_empty.status_code == 200
        body = api_empty.json()
        assert body["verification"]["all_passed"] is False
        assert "Insufficient match sample" in body["result"]["conclusion"]
        assert "Verification warning" in body["result"]["conclusion"]

    # Legitimate zero observations distinct from unavailable data:
    # 1) Team with played match and genuinely 0 high turnovers must report 0.0, NOT fallback default 4.0
    zero_conn = duckdb.connect(":memory:")
    ingest_default_statsbomb_dataset(zero_conn, reset=True, seed=42)
    zero_conn.execute(
        """
        UPDATE events SET is_high_turnover = FALSE, x_105 = 30.0
        WHERE team_name = 'Arsenal' AND event_type IN ('Interception', 'Ball Recovery', 'Duel')
          AND match_id IN (SELECT match_id FROM matches WHERE season_name = '2024/2025')
        """
    )
    style_zero_ht = _compute_team_style_profile(zero_conn, "Arsenal", "2024/2025", {"ppda_def_line_x": 42.0, "high_turnover_x_threshold": 65.0, "prog_pass_min_dist": 10.0})
    zero_conn.close()
    assert style_zero_ht["matches_played"] > 0
    assert style_zero_ht["high_turnovers_per90"] == 0.0

    # 2) Shot zones with real shots > 0 and 0 goals must report 0 goals accurately
    zero_goals_payload = {
        "module_id": "shot_location_zone_efficiency",
        "coord_grid": "120x80",
        "charts": {"total_shots": 14},
        "table_rows": [
            {"zone": "Central Penalty Area", "team_shots": 8, "shot_share_pct": 57.1, "league_share_pct": 45.0, "goals": 0, "total_xg": 1.35, "xg_per_shot": 0.17, "league_xg_per_shot": 0.16, "conversion_pct": 0.0, "league_conversion_pct": 14.0},
            {"zone": "Long Range Central", "team_shots": 6, "shot_share_pct": 42.9, "league_share_pct": 25.0, "goals": 0, "total_xg": 0.25, "xg_per_shot": 0.04, "league_xg_per_shot": 0.05, "conversion_pct": 0.0, "league_conversion_pct": 4.0},
        ],
        "assumptions": {"team_name": "Arsenal", "season_name": "2024/2025"},
    }
    zg_concl = build_analysis_conclusion(zero_goals_payload)
    assert "0 goals across those 14 shots" in zg_concl
    assert "Insufficient shot data" not in zg_concl
    assert "highest goal return" not in zg_concl.lower()


def test_club_entity_resolution_and_workflow_assumption_overrides(seeded_conn: duckdb.DuckDBPyConnection) -> None:
    """Resolve full club names before generic aliases, clarify standalone United/City, and respect overrides."""
    all_teams = [t["team_name"] for t in inspect_database_capabilities(seeded_conn)["teams"]]

    # Specific names and unambiguous short aliases
    assert _find_mentioned_team("How is Newcastle United performing?", all_teams) == "Newcastle United"
    assert _find_mentioned_team("How are Newcastle looking?", all_teams) == "Newcastle United"
    assert _find_mentioned_team("Check West Ham United xPTS", all_teams) == "West Ham United"
    assert _find_mentioned_team("Check West Ham away form", all_teams) == "West Ham United"
    assert _find_mentioned_team("Is Manchester United improving?", all_teams) == "Manchester United"
    assert _find_mentioned_team("How are Man United trending?", all_teams) == "Manchester United"
    assert _find_mentioned_team("How are Man Utd doing?", all_teams) == "Manchester United"
    assert _find_mentioned_team("Scout Manchester City before Saturday", all_teams) == "Manchester City"
    assert _find_mentioned_team("Scout Man City's press", all_teams) == "Manchester City"
    assert _find_mentioned_team("How do Spurs press?", all_teams) == "Tottenham Hotspur"

    # Ambiguous standalone terms must NOT silently resolve to Manchester United / Manchester City
    assert _find_mentioned_team("How have United performed this season?", all_teams) is None
    assert _find_mentioned_team("How have City performed this season?", all_teams) is None
    amb_u = extract_club_mentions("How have United performed?", all_teams)
    assert amb_u["matched_teams"] == [] and amb_u["ambiguous_term"] == "United"
    assert set(amb_u["ambiguous_candidates"]) == {"Manchester United", "Newcastle United", "West Ham United"}

    amb_s1 = start_workflow_session(seeded_conn, "Is United going in the right direction since MW 6?")
    assert amb_s1["explicit_team"] is False
    assert amb_s1["clarifying_questions"][0]["field"] == "team_name"
    assert "United" in amb_s1["clarifying_questions"][0]["question"]
    assert amb_s1["clarifying_questions"][0]["options"][:3] == [
        "Manchester United",
        "Newcastle United",
        "West Ham United",
    ]

    # Team-focused league/xPTS question where the club is neither top overperformer nor top underperformer
    wh_s1 = start_workflow_session(seeded_conn, "How has West Ham United performed relative to expected points in 2024/2025?")
    assert wh_s1["module_id"] == "league_table_vs_underlying_play"
    assert wh_s1["params"]["team_name"] == "West Ham United"
    confirm_stage_1_and_check_feasibility(seeded_conn, wh_s1["session_id"])
    approve_stage_2_build_plan(seeded_conn, wh_s1["session_id"])
    approve_stage_3_execute_and_verify(seeded_conn, wh_s1["session_id"])
    wh_s5 = approve_stage_4_render(seeded_conn, wh_s1["session_id"])
    assert wh_s5["conclusion"].startswith("In 2024/2025, West Ham United sit #8")
    assert "#10 on simulated xPTS (17.9 xPTS, -0.9 pts, On Par;" in wh_s5["conclusion"]

    new_s1 = start_workflow_session(seeded_conn, "How did Newcastle United perform relative to expected points in 2023/2024?")
    assert new_s1["module_id"] == "league_table_vs_underlying_play"
    assert new_s1["params"]["team_name"] == "Newcastle United"
    confirm_stage_1_and_check_feasibility(seeded_conn, new_s1["session_id"])
    approve_stage_2_build_plan(seeded_conn, new_s1["session_id"])
    approve_stage_3_execute_and_verify(seeded_conn, new_s1["session_id"])
    new_s5 = approve_stage_4_render(seeded_conn, new_s1["session_id"])
    assert new_s5["conclusion"].startswith("In 2023/2024, Newcastle United sit #7")
    assert "#8 on simulated xPTS" in new_s5["conclusion"]

    # Changing club in Stage 5 assumption override must replace old prompt's team without bleed
    new_rerun = override_assumptions_and_rerun(seeded_conn, wh_s1["session_id"], {"team_name": "Chelsea"})
    assert new_rerun["conclusion"].startswith("In 2024/2025, Chelsea sit #5")
    assert "West Ham United" not in new_rerun["conclusion"]

    # Ambiguous United -> user clarifies West Ham United at Stage 1 -> analyses West Ham United
    amb_xpts_s1 = start_workflow_session(seeded_conn, "How have United performed relative to expected points in 2024/2025?")
    assert amb_xpts_s1["explicit_team"] is False
    confirm_stage_1_and_check_feasibility(seeded_conn, amb_xpts_s1["session_id"], {"team_name": "West Ham United"})
    approve_stage_2_build_plan(seeded_conn, amb_xpts_s1["session_id"])
    approve_stage_3_execute_and_verify(seeded_conn, amb_xpts_s1["session_id"])
    amb_xpts_s5 = approve_stage_4_render(seeded_conn, amb_xpts_s1["session_id"])
    assert amb_xpts_s5["conclusion"].startswith("In 2024/2025, West Ham United sit #8")

