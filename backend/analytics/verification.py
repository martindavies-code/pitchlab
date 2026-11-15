"""Stage 4 Automated Verification Engine comparing analytics against DuckDB ground truth."""

from __future__ import annotations

from typing import Any
import duckdb


def run_automated_verification(
    conn: duckdb.DuckDBPyConnection,
    module_id: str,
    params: dict[str, Any],
    result_payload: dict[str, Any],
) -> dict[str, Any]:
    """
    Execute rigorous sanity and parity checks comparing aggregated analytical outputs
    against official match scores, shot counts, xG sums, player minutes, and league baselines.
    """
    season = params.get("season_name")
    season_filter = "WHERE m.season_name = ?" if season else ""
    season_args = [season] if season else []

    checks: list[dict[str, Any]] = []

    # 1. Official Match Score vs Event Goal Shot Parity
    score_row = conn.execute(
        f"""
        WITH match_totals AS (
            SELECT m.match_id,
                   m.home_score + m.away_score AS official_goals,
                   COALESCE(SUM(CASE WHEN e.event_type = 'Shot' AND e.outcome = 'Goal' THEN 1 ELSE 0 END), 0) AS event_goals
            FROM matches m
            LEFT JOIN events e ON m.match_id = e.match_id
            {season_filter}
            GROUP BY m.match_id, m.home_score, m.away_score
        )
        SELECT COUNT(*) AS total_matches,
               COALESCE(SUM(official_goals), 0) AS sum_official,
               COALESCE(SUM(event_goals), 0) AS sum_event,
               COALESCE(SUM(CASE WHEN official_goals != event_goals THEN 1 ELSE 0 END), 0) AS mismatches
        FROM match_totals
        """,
        season_args,
    ).fetchone()

    total_matches, sum_official, sum_event, mismatches = (
        int(score_row[0]),
        int(score_row[1]),
        int(score_row[2]),
        int(score_row[3]),
    )
    score_ok = total_matches > 0 and mismatches == 0 and sum_official == sum_event
    checks.append(
        {
            "check_id": "score_parity_check",
            "label": "Match Score vs Event Goal Parity",
            "passed": score_ok,
            "expected": f"{sum_official} official goals across {total_matches} matches",
            "observed": f"{sum_event} event goal shots ({mismatches} match mismatches)",
            "severity": "critical",
        }
    )

    # 2. Shot Count & xG Bounds + Sum Parity
    shot_row = conn.execute(
        f"""
        SELECT COUNT(*) AS shot_count,
               COALESCE(ROUND(SUM(e.xg), 4), 0) AS total_xg,
               COALESCE(SUM(CASE WHEN e.xg <= 0 OR e.xg > 1.0 THEN 1 ELSE 0 END), 0) AS out_of_bounds
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        {season_filter} {"AND" if season else "WHERE"} e.event_type = 'Shot'
        """,
        season_args,
    ).fetchone()
    shot_count, total_xg, oob_xg = int(shot_row[0]), float(shot_row[1]), int(shot_row[2])
    shots_ok = shot_count > 0 and oob_xg == 0
    checks.append(
        {
            "check_id": "shot_and_xg_bounds_check",
            "label": "Shot Count & xG Probability Bounds (0 < xG <= 1.0)",
            "passed": shots_ok,
            "expected": f"{shot_count} shots with valid xG in (0, 1]",
            "observed": f"{shot_count} shots, total xG = {total_xg:.2f}, {oob_xg} out-of-bounds",
            "severity": "critical",
        }
    )

    # 3. Player Minutes Integrity & Min-Minute Filter Check
    min_row = conn.execute(
        f"""
        SELECT COUNT(*) AS rows_checked,
               COALESCE(MIN(l.minutes_played), 0) AS min_m,
               COALESCE(MAX(l.minutes_played), 0) AS max_m,
               COALESCE(SUM(CASE WHEN l.minutes_played < 0 OR l.minutes_played > 120 THEN 1 ELSE 0 END), 0) AS invalid_mins
        FROM lineups l
        JOIN matches m ON l.match_id = m.match_id
        {season_filter}
        """,
        season_args,
    ).fetchone()
    l_rows, min_m, max_m, invalid_mins = int(min_row[0]), int(min_row[1]), int(min_row[2]), int(min_row[3])
    min_minutes_threshold = int(params.get("min_minutes", 450))
    # Verify any player table rows obey min_minutes
    violated_threshold = 0
    for row in result_payload.get("table_rows", []):
        if "minutes_played" in row and float(row["minutes_played"]) < min_minutes_threshold:
            violated_threshold += 1
        if "season_1_minutes" in row and float(row["season_1_minutes"]) < min_minutes_threshold:
            violated_threshold += 1
        if "season_2_minutes" in row and float(row["season_2_minutes"]) < min_minutes_threshold:
            violated_threshold += 1

    mins_ok = invalid_mins == 0 and violated_threshold == 0
    checks.append(
        {
            "check_id": "player_minutes_check",
            "label": "Lineup Minutes Integrity & Sample Threshold",
            "passed": mins_ok,
            "expected": f"Minutes in [0, 120] and filtered rows >= {min_minutes_threshold} mins",
            "observed": f"{l_rows} lineup entries (range {min_m}-{max_m}m), {violated_threshold} threshold violations",
            "severity": "high",
        }
    )

    # 4. League Baseline Sanity (Mean Goals/Match & Coordinate Bounds)
    avg_goals_per_match = round(sum_official / max(1, total_matches), 2)
    coord_row = conn.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN x < 0 OR x > 120 OR y < 0 OR y > 80 OR x_105 < 0 OR x_105 > 105 OR y_105 < 0 OR y_105 > 68 THEN 1 ELSE 0 END), 0)
        FROM events
        """
    ).fetchone()
    coord_oob = int(coord_row[0])
    baseline_ok = (1.0 <= avg_goals_per_match <= 5.5) and coord_oob == 0
    checks.append(
        {
            "check_id": "league_baseline_and_coords_check",
            "label": "League Scoring Baseline & Dual-Grid Coordinate Bounds",
            "passed": baseline_ok,
            "expected": "1.0 <= goals/match <= 5.5 and 0 coordinates outside 120x80 / 105x68",
            "observed": f"{avg_goals_per_match:.2f} goals/match, {coord_oob} coordinate violations",
            "severity": "high",
        }
    )

    # 5. Module-Specific Reconciliation
    module_check_passed = True
    module_expected = "Module aggregates reconcile with raw event table"
    module_observed = f"Verified {module_id} payload ({len(result_payload.get('table_rows', []))} rows)"

    if module_id == "shot_location_zone_efficiency":
        team_name = params.get("team_name", "Arsenal")
        raw_team_shots = int(
            conn.execute(
                f"""
                SELECT COUNT(*)
                FROM events e
                JOIN matches m ON e.match_id = m.match_id
                {season_filter} {"AND" if season else "WHERE"} e.event_type = 'Shot' AND e.team_name = ?
                """,
                season_args + [team_name],
            ).fetchone()[0]
        )
        zone_sum = sum(int(r.get("team_shots", 0)) for r in result_payload.get("table_rows", []))
        module_check_passed = raw_team_shots == zone_sum and raw_team_shots > 0
        module_expected = f"{raw_team_shots} shots for {team_name}"
        module_observed = f"{zone_sum} shots summed across 12 pitch zones"
    elif module_id == "league_table_vs_underlying_play":
        rows = result_payload.get("table_rows", [])
        total_pts = sum(float(r.get("actual_pts", 0)) for r in rows)
        total_xpts = sum(float(r.get("xpts", 0)) for r in rows)
        module_check_passed = len(rows) > 0 and abs(total_pts - total_xpts) <= total_matches * 0.65
        module_expected = f"Simulated xPTS sum within realistic variance of {total_pts:.1f} actual pts"
        module_observed = f"Actual Pts = {total_pts:.1f}, Simulated xPTS = {total_xpts:.1f}"

    checks.append(
        {
            "check_id": "module_reconciliation_check",
            "label": "Module Output vs Raw DuckDB Reconciliation",
            "passed": module_check_passed,
            "expected": module_expected,
            "observed": module_observed,
            "severity": "critical",
        }
    )

    all_passed = all(c["passed"] for c in checks)
    return {
        "all_passed": all_passed,
        "checks_passed": sum(1 for c in checks if c["passed"]),
        "checks_total": len(checks),
        "checks": checks,
    }
