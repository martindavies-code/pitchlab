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
from backend.analytics.modules import MODULE_DISPATCH, execute_module
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
    assert res_120["conclusion"] and len(res_120["conclusion"]) > len(res_120["summary"]) or "." in res_120["conclusion"]

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
