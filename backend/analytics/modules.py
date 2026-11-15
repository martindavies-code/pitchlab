"""Seven Core Analytical Modules executed against DuckDB canonical tables."""

from __future__ import annotations

import math
from typing import Any
import duckdb


DEFAULT_ASSUMPTIONS: dict[str, Any] = {
    "season_name": "2024/2025",
    "season_1": "2023/2024",
    "season_2": "2024/2025",
    "team_name": "Manchester United",
    "opponent_name": "Arsenal",
    "player_name": "Cole Palmer",
    "target_club": "Arsenal",
    "min_minutes": 450,
    "normalisation": "per_90",  # 'per_90' | 'possession_adjusted'
    "coord_grid": "120x80",     # '120x80' | '105x68'
    "rolling_window": 4,
    "milestone_match_week": 10,
    "start_mw": 10,
    "end_mw": 18,
    "ppda_def_line_x": 42.0,    # in 105x68 meters (opp half + deep build-up)
    "high_turnover_x_threshold": 65.0,  # in 105x68 meters (within 40m of opp goal)
    "prog_pass_min_dist": 10.0, # in 105x68 meters
    "skill_composite": "ball_progression",  # 'ball_progression' | 'box_threat' | 'defensive_disruption' | 'chance_creation'
}


def merge_assumptions(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    """Merge user overrides cleanly onto default analytical assumptions."""
    cfg = dict(DEFAULT_ASSUMPTIONS)
    if overrides:
        for k, v in overrides.items():
            if v is not None:
                cfg[k] = v
    return cfg


def _coord_pair(x120: float, y80: float, x105: float, y68: float, grid: str) -> tuple[float, float]:
    return (round(x105, 2), round(y68, 2)) if grid == "105x68" else (round(x120, 2), round(y80, 2))


def _compute_team_style_profile(
    conn: duckdb.DuckDBPyConnection,
    team_name: str,
    season_name: str,
    assumptions: dict[str, Any],
    mw_start: int | None = None,
    mw_end: int | None = None,
) -> dict[str, float]:
    """Compute core tactical style KPIs for a club across a season or custom matchweek run."""
    ppda_x = float(assumptions["ppda_def_line_x"])
    ht_x = float(assumptions["high_turnover_x_threshold"])
    prog_d = float(assumptions["prog_pass_min_dist"])

    mw_clause = ""
    args: list[Any] = [season_name, team_name, team_name]
    if mw_start is not None and mw_end is not None:
        mw_clause = "AND m.match_week BETWEEN ? AND ?"
        args.extend([int(mw_start), int(mw_end)])

    row = conn.execute(
        f"""
        WITH scoped_matches AS (
            SELECT m.match_id
            FROM matches m
            WHERE m.season_name = ?
              AND (m.home_team_name = ? OR m.away_team_name = ?)
              {mw_clause}
        ),
        poss_stats AS (
            SELECT COUNT(*) AS total_poss,
                   SUM(CASE WHEN e.possession_team_name = ? THEN 1 ELSE 0 END) AS team_poss
            FROM (
                SELECT DISTINCT match_id, possession, possession_team_name
                FROM events
                WHERE match_id IN (SELECT match_id FROM scoped_matches)
            ) e
        ),
        event_stats AS (
            SELECT
                COUNT(DISTINCT e.match_id) AS matches_played,
                SUM(CASE WHEN e.team_name = ? AND e.event_type = 'Pass' THEN 1 ELSE 0 END) AS team_passes,
                SUM(CASE WHEN e.team_name = ? AND e.event_type = 'Pass' AND e.outcome = 'Complete'
                         AND SQRT(POWER(105.0 - e.x_105, 2) + POWER(34.0 - e.y_105, 2))
                           - SQRT(POWER(105.0 - COALESCE(e.end_x_105, e.x_105), 2) + POWER(34.0 - COALESCE(e.end_y_105, e.y_105), 2)) >= ?
                         THEN 1 ELSE 0 END) AS prog_passes,
                SUM(CASE WHEN e.team_name = ? AND e.event_type = 'Pass' AND e.pass_height = 'High Pass' THEN 1 ELSE 0 END) AS long_passes,
                SUM(CASE WHEN e.team_name = ? AND e.is_box_entry THEN 1 ELSE 0 END) AS box_entries,
                SUM(CASE WHEN e.team_name = ? AND e.event_type = 'Shot' THEN e.xg ELSE 0 END) AS xg_for,
                SUM(CASE WHEN e.team_name = ? AND e.is_defensive_action AND e.x_105 >= ? THEN 1 ELSE 0 END) AS high_def_actions,
                SUM(CASE WHEN e.team_name = ? AND e.event_type IN ('Interception', 'Ball Recovery', 'Duel') AND e.x_105 >= ? THEN 1 ELSE 0 END) AS high_turnovers,
                SUM(CASE WHEN e.team_name != ? AND e.event_type = 'Pass' AND e.outcome = 'Complete' AND (105.0 - e.x_105) >= ? THEN 1 ELSE 0 END) AS opp_buildup_passes
            FROM events e
            WHERE e.match_id IN (SELECT match_id FROM scoped_matches)
        )
        SELECT
            es.matches_played,
            ROUND(100.0 * ps.team_poss / GREATEST(1, ps.total_poss), 1) AS possession_share,
            ROUND(es.opp_buildup_passes * 1.0 / GREATEST(1, es.high_def_actions), 2) AS ppda,
            ROUND(100.0 * es.long_passes / GREATEST(1, es.team_passes), 1) AS build_up_directness,
            ROUND(es.high_turnovers * 1.0 / GREATEST(1, es.matches_played), 2) AS high_turnovers_per90,
            ROUND(es.prog_passes * 1.0 / GREATEST(1, es.matches_played), 2) AS progressive_passes_per90,
            ROUND(es.box_entries * 1.0 / GREATEST(1, es.matches_played), 2) AS box_entries_per90,
            ROUND(es.xg_for * 1.0 / GREATEST(1, es.matches_played), 2) AS xg_per90
        FROM event_stats es CROSS JOIN poss_stats ps
        """,
        args + [team_name, team_name, team_name, prog_d, team_name, team_name, team_name, team_name, ppda_x, team_name, ht_x, team_name, ppda_x],
    ).fetchone()

    return {
        "matches_played": int(row[0] or 0),
        "possession_share": float(row[1] or 50.0),
        "ppda": float(row[2] or 12.0),
        "build_up_directness": float(row[3] or 35.0),
        "high_turnovers_per90": float(row[4] or 4.0),
        "progressive_passes_per90": float(row[5] or 30.0),
        "box_entries_per90": float(row[6] or 12.0),
        "xg_per90": float(row[7] or 1.2),
    }


def run_managerial_impact_tracker(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 1: Managerial Impact Tracker
    Plots rolling PPG and rolling xG created vs xG conceded across a season with
    vertical milestone markers on manager changes or tactical shifts.
    """
    cfg = merge_assumptions(overrides)
    team = str(cfg["team_name"])
    season = str(cfg["season_name"])
    window = max(2, min(10, int(cfg["rolling_window"])))
    grid = str(cfg["coord_grid"])

    rows = conn.execute(
        """
        WITH team_matches AS (
            SELECT m.match_id,
                   m.match_week,
                   m.match_date::VARCHAR AS match_date,
                   CASE WHEN m.home_team_name = ? THEN m.away_team_name ELSE m.home_team_name END AS opponent,
                   CASE WHEN m.home_team_name = ? THEN 'H' ELSE 'A' END AS venue,
                   CASE WHEN m.home_team_name = ? THEN m.home_manager ELSE m.away_manager END AS manager,
                   CASE WHEN m.home_team_name = ? THEN m.home_formation ELSE m.away_formation END AS formation,
                   CASE WHEN m.home_team_name = ? THEN m.home_score ELSE m.away_score END AS gf,
                   CASE WHEN m.home_team_name = ? THEN m.away_score ELSE m.home_score END AS ga
            FROM matches m
            WHERE m.season_name = ?
              AND (m.home_team_name = ? OR m.away_team_name = ?)
        ),
        shot_xg AS (
            SELECT e.match_id,
                   SUM(CASE WHEN e.team_name = ? THEN e.xg ELSE 0 END) AS xgf,
                   SUM(CASE WHEN e.team_name != ? THEN e.xg ELSE 0 END) AS xga
            FROM events e
            WHERE e.event_type = 'Shot'
              AND e.match_id IN (SELECT match_id FROM team_matches)
            GROUP BY e.match_id
        )
        SELECT tm.match_id, tm.match_week, tm.match_date, tm.opponent, tm.venue,
               tm.manager, tm.formation, tm.gf, tm.ga,
               ROUND(COALESCE(sx.xgf, 0), 2) AS xgf,
               ROUND(COALESCE(sx.xga, 0), 2) AS xga
        FROM team_matches tm
        LEFT JOIN shot_xg sx ON tm.match_id = sx.match_id
        ORDER BY tm.match_week ASC
        """,
        [team, team, team, team, team, team, season, team, team, team, team],
    ).fetchall()

    timeline: list[dict[str, Any]] = []
    milestones: list[dict[str, Any]] = []
    prev_mgr: str | None = None
    override_mw = overrides.get("milestone_match_week") if overrides else None

    for idx, r in enumerate(rows):
        gf, ga = int(r[7]), int(r[8])
        pts = 3 if gf > ga else (1 if gf == ga else 0)
        mgr = str(r[5])
        mw = int(r[1])
        is_change = (prev_mgr is not None and mgr != prev_mgr) or (override_mw is not None and int(override_mw) == mw and not milestones)
        if is_change:
            milestones.append(
                {
                    "match_week": mw,
                    "match_date": r[2],
                    "label": f"Manager Shift: {mgr}" if prev_mgr and mgr != prev_mgr else f"Tactical Milestone (MW {mw})",
                    "previous_manager": prev_mgr or mgr,
                    "new_manager": mgr,
                }
            )
        prev_mgr = mgr
        timeline.append(
            {
                "match_id": int(r[0]),
                "match_week": mw,
                "match_date": r[2],
                "opponent": r[3],
                "venue": r[4],
                "manager": mgr,
                "formation": r[6],
                "gf": gf,
                "ga": ga,
                "pts": pts,
                "xgf": float(r[9]),
                "xga": float(r[10]),
            }
        )

    # Default milestone at user-configured matchweek if club kept same manager all season
    if not milestones and timeline:
        split_mw = min(max(2, int(cfg["milestone_match_week"])), timeline[-1]["match_week"])
        target_row = next((t for t in timeline if t["match_week"] >= split_mw), timeline[len(timeline) // 2])
        milestones.append(
            {
                "match_week": target_row["match_week"],
                "match_date": target_row["match_date"],
                "label": f"Tactical Benchmark (MW {target_row['match_week']})",
                "previous_manager": target_row["manager"],
                "new_manager": target_row["manager"],
            }
        )

    # Compute rolling metrics
    for i, item in enumerate(timeline):
        win_slice = timeline[max(0, i - window + 1) : i + 1]
        item["rolling_ppg"] = round(sum(x["pts"] for x in win_slice) / len(win_slice), 2)
        item["rolling_xgf"] = round(sum(x["xgf"] for x in win_slice) / len(win_slice), 2)
        item["rolling_xga"] = round(sum(x["xga"] for x in win_slice) / len(win_slice), 2)

    split_mw = milestones[0]["match_week"] if milestones else 10
    before = [t for t in timeline if t["match_week"] < split_mw]
    after = [t for t in timeline if t["match_week"] >= split_mw]

    def _agg_period(label: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        n = max(1, len(items))
        return {
            "period": label,
            "matches": len(items),
            "ppg": round(sum(x["pts"] for x in items) / n, 2),
            "gf_per90": round(sum(x["gf"] for x in items) / n, 2),
            "ga_per90": round(sum(x["ga"] for x in items) / n, 2),
            "xgf_per90": round(sum(x["xgf"] for x in items) / n, 2),
            "xga_per90": round(sum(x["xga"] for x in items) / n, 2),
            "xg_diff_per90": round((sum(x["xgf"] - x["xga"] for x in items)) / n, 2),
        }

    before_stats = _agg_period(f"Before MW {split_mw}", before)
    after_stats = _agg_period(f"From MW {split_mw} Onwards", after)
    comparison_table = [before_stats, after_stats]

    # Pitch markers: shots created before vs after milestone
    shot_rows = conn.execute(
        """
        SELECT e.x, e.y, e.x_105, e.y_105, e.xg, e.outcome, e.player_name, m.match_week
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.team_name = ? AND e.event_type = 'Shot'
        ORDER BY m.match_week DESC, e.xg DESC
        LIMIT 80
        """,
        [season, team],
    ).fetchall()

    pitch_markers = []
    for sr in shot_rows:
        px, py = _coord_pair(sr[0], sr[1], sr[2], sr[3], grid)
        is_post = int(sr[7]) >= split_mw
        pitch_markers.append(
            {
                "x": px,
                "y": py,
                "radius": round(3.0 + float(sr[4]) * 9.0, 2),
                "color": "#10b981" if sr[5] == "Goal" else ("#38bdf8" if is_post else "#f59e0b"),
                "label": f"{sr[6]} (MW{sr[7]}, xG {sr[4]:.2f}, {sr[5]})",
                "group": "Post-Shift" if is_post else "Pre-Shift",
            }
        )

    ppg_delta = round(after_stats["ppg"] - before_stats["ppg"], 2)
    xgd_delta = round(after_stats["xg_diff_per90"] - before_stats["xg_diff_per90"], 2)
    direction = "improving" if xgd_delta > 0.05 else ("declining" if xgd_delta < -0.05 else "holding steady")

    return {
        "module_id": "managerial_impact_tracker",
        "title": f"Managerial Impact Tracker — {team} ({season})",
        "coord_grid": grid,
        "summary": (
            f"{team} is {direction} after MW {split_mw}: rolling xG differential moved by "
            f"{xgd_delta:+.2f} per match ({before_stats['xg_diff_per90']:+.2f} → {after_stats['xg_diff_per90']:+.2f}) "
            f"and points per game shifted by {ppg_delta:+.2f} ({before_stats['ppg']:.2f} → {after_stats['ppg']:.2f})."
        ),
        "charts": {
            "timeline": timeline,
            "milestones": milestones,
            "rolling_window": window,
        },
        "pitch": {
            "title": f"{team} Shot Map (Blue = From MW {split_mw}, Amber = Before MW {split_mw}, Green = Goals)",
            "markers": pitch_markers,
            "arrows": [],
            "zones": [],
        },
        "table_columns": ["period", "matches", "ppg", "gf_per90", "ga_per90", "xgf_per90", "xga_per90", "xg_diff_per90"],
        "table_rows": comparison_table,
        "assumptions": cfg,
    }


def run_tactical_intervention_comparison(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 2: Tactical Intervention Comparison
    Compares a club's custom match run against its own season baseline across
    PPDA, build-up directness, possession share, high turnovers, and progressive passes.
    """
    cfg = merge_assumptions(overrides)
    team = str(cfg["team_name"])
    season = str(cfg["season_name"])
    start_mw = int(cfg["start_mw"])
    end_mw = int(cfg["end_mw"])
    grid = str(cfg["coord_grid"])

    season_profile = _compute_team_style_profile(conn, team, season, cfg)
    run_profile = _compute_team_style_profile(conn, team, season, cfg, start_mw, end_mw)

    # League baselines across all clubs for percentile calculation
    all_teams = [
        r[0] for r in conn.execute("SELECT DISTINCT team_name FROM teams ORDER BY team_name").fetchall()
    ]
    league_profiles = [_compute_team_style_profile(conn, t, season, cfg) for t in all_teams]

    def _percentile(val: float, series: list[float], lower_is_better: bool = False) -> int:
        if not series:
            return 50
        rank = sum(1 for s in series if (s >= val if lower_is_better else s <= val))
        return int(round(100.0 * rank / len(series)))

    metrics_spec = [
        ("ppda", "Pressing Intensity (Lower PPDA)", True),
        ("possession_share", "Possession Share (%)", False),
        ("build_up_directness", "Build-up Directness (%)", False),
        ("high_turnovers_per90", "High Turnovers / 90", False),
        ("progressive_passes_per90", "Progressive Passes / 90", False),
        ("box_entries_per90", "Penalty Box Entries / 90", False),
    ]

    radar_data = []
    table_rows = []
    for key, label, invert in metrics_spec:
        series = [lp[key] for lp in league_profiles]
        s_val = season_profile[key]
        r_val = run_profile[key]
        s_pct = _percentile(s_val, series, lower_is_better=invert)
        r_pct = _percentile(r_val, series, lower_is_better=invert)
        delta = round(r_val - s_val, 2)
        radar_data.append(
            {
                "metric": label,
                "key": key,
                "season_avg": s_val,
                "intervention_run": r_val,
                "season_percentile": s_pct,
                "run_percentile": r_pct,
                "delta": delta,
            }
        )
        table_rows.append(
            {
                "metric": label,
                "season_avg": s_val,
                "intervention_run": r_val,
                "delta": delta,
                "season_pct": s_pct,
                "run_pct": r_pct,
            }
        )

    # Progressive passes & high turnovers during the intervention window for SVG pitch
    ev_rows = conn.execute(
        """
        SELECT e.event_type, e.x, e.y, e.end_x, e.end_y, e.x_105, e.y_105, e.end_x_105, e.end_y_105, e.player_name, m.match_week
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.team_name = ? AND m.match_week BETWEEN ? AND ?
          AND (e.is_progressive_pass = TRUE OR e.is_high_turnover = TRUE)
        ORDER BY m.match_week DESC
        LIMIT 60
        """,
        [season, team, start_mw, end_mw],
    ).fetchall()

    arrows = []
    markers = []
    for er in ev_rows:
        px, py = _coord_pair(er[1], er[2], er[5], er[6], grid)
        if er[0] == "Pass" and er[3] is not None and er[4] is not None:
            ex, ey = _coord_pair(er[3], er[4], er[7], er[8], grid)
            arrows.append(
                {
                    "x1": px,
                    "y1": py,
                    "x2": ex,
                    "y2": ey,
                    "color": "#38bdf8",
                    "label": f"Prog Pass: {er[9]} (MW{er[10]})",
                }
            )
        else:
            markers.append(
                {
                    "x": px,
                    "y": py,
                    "radius": 4.2,
                    "color": "#f43f5e",
                    "label": f"High Turnover: {er[9]} (MW{er[10]})",
                    "group": "High Turnover",
                }
            )

    return {
        "module_id": "tactical_intervention_comparison",
        "title": f"Tactical Intervention Comparison — {team} (MW {start_mw}–{end_mw} vs Season Avg)",
        "coord_grid": grid,
        "summary": (
            f"During MW {start_mw}–{end_mw} ({run_profile['matches_played']} matches), {team} recorded PPDA of "
            f"{run_profile['ppda']:.2f} (season avg {season_profile['ppda']:.2f}), {run_profile['possession_share']:.1f}% possession "
            f"(season {season_profile['possession_share']:.1f}%), and {run_profile['progressive_passes_per90']:.1f} progressive passes/90."
        ),
        "charts": {
            "radar": radar_data,
            "match_window": {"start_mw": start_mw, "end_mw": end_mw, "matches": run_profile["matches_played"]},
        },
        "pitch": {
            "title": f"{team} Progressive Passes (Blue Arrows) & High Turnovers (Red Dots) in MW {start_mw}–{end_mw}",
            "arrows": arrows[:35],
            "markers": markers[:35],
            "zones": [],
        },
        "table_columns": ["metric", "season_avg", "intervention_run", "delta", "season_pct", "run_pct"],
        "table_rows": table_rows,
        "assumptions": cfg,
    }


def run_opposition_scouting_one_pager(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 3: Opposition Scouting One-Pager
    Printable pre-match dossier covering pressing trigger zones, directness,
    primary formations, and match-state shape switches (winning, drawing, losing).
    """
    cfg = merge_assumptions(overrides)
    opp = str(cfg["opponent_name"])
    season = str(cfg["season_name"])
    grid = str(cfg["coord_grid"])

    opp_style = _compute_team_style_profile(conn, opp, season, cfg)

    # Match-state tactical breakdown
    state_rows = conn.execute(
        """
        SELECT e.match_state,
               MODE() WITHIN GROUP (ORDER BY e.tactical_formation) AS primary_shape,
               COUNT(*) AS total_events,
               ROUND(100.0 * SUM(CASE WHEN e.event_type = 'Pass' AND e.pass_height = 'High Pass' THEN 1 ELSE 0 END)
                     / GREATEST(1, SUM(CASE WHEN e.event_type = 'Pass' THEN 1 ELSE 0 END)), 1) AS directness_pct,
               ROUND(100.0 * SUM(CASE WHEN e.is_progressive_pass THEN 1 ELSE 0 END)
                     / GREATEST(1, SUM(CASE WHEN e.event_type = 'Pass' THEN 1 ELSE 0 END)), 1) AS prog_pass_share,
               ROUND(AVG(CASE WHEN e.is_defensive_action THEN e.x_105 END), 1) AS avg_def_line_m
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.team_name = ?
        GROUP BY e.match_state
        ORDER BY CASE e.match_state WHEN 'winning' THEN 1 WHEN 'drawing' THEN 2 ELSE 3 END
        """,
        [season, opp],
    ).fetchall()

    table_rows = [
        {
            "match_state": str(r[0]).title(),
            "primary_shape": str(r[1]),
            "events": int(r[2]),
            "directness_pct": float(r[3] or 0),
            "prog_pass_share": float(r[4] or 0),
            "avg_def_line_m": float(r[5] or 45.0),
        }
        for r in state_rows
    ]

    # 6 Pressing trigger zones (3 vertical thirds x 2/3 channels)
    press_rows = conn.execute(
        """
        SELECT
            CASE WHEN e.x_105 < 35 THEN 'Low Block' WHEN e.x_105 < 70 THEN 'Mid Block' ELSE 'High Press' END AS third_band,
            CASE WHEN e.y_105 < 22.6 THEN 'Left Wing' WHEN e.y_105 <= 45.4 THEN 'Central Corridor' ELSE 'Right Wing' END AS lane,
            COUNT(*) AS press_count,
            SUM(CASE WHEN e.is_high_turnover THEN 1 ELSE 0 END) AS turnovers_won
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.team_name = ? AND e.is_defensive_action = TRUE
        GROUP BY third_band, lane
        """,
        [season, opp],
    ).fetchall()

    max_press = max([int(r[2]) for r in press_rows] or [1])
    x_bounds = {
        "Low Block": (0.0, 40.0) if grid == "120x80" else (0.0, 35.0),
        "Mid Block": (40.0, 80.0) if grid == "120x80" else (35.0, 70.0),
        "High Press": (80.0, 120.0) if grid == "120x80" else (70.0, 105.0),
    }
    y_bounds = {
        "Left Wing": (0.0, 26.7) if grid == "120x80" else (0.0, 22.6),
        "Central Corridor": (26.7, 53.3) if grid == "120x80" else (22.6, 45.4),
        "Right Wing": (53.3, 80.0) if grid == "120x80" else (45.4, 68.0),
    }

    zones = []
    for pr in press_rows:
        x0, x1 = x_bounds[pr[0]]
        y0, y1 = y_bounds[pr[1]]
        cnt = int(pr[2])
        zones.append(
            {
                "zone_id": f"{pr[0]} - {pr[1]}",
                "x": x0,
                "y": y0,
                "width": round(x1 - x0, 2),
                "height": round(y1 - y0, 2),
                "intensity": round(cnt / max_press, 3),
                "value_label": f"{cnt}",
                "tooltip": f"{pr[0]} ({pr[1]}): {cnt} defensive triggers, {int(pr[3])} turnovers",
            }
        )

    # Top 3 danger players for opponent
    threats = conn.execute(
        """
        SELECT e.player_name, e.position_name,
               ROUND(SUM(CASE WHEN e.event_type = 'Shot' THEN e.xg ELSE 0 END), 2) AS total_xg,
               SUM(CASE WHEN e.is_key_pass THEN 1 ELSE 0 END) AS key_passes,
               SUM(CASE WHEN e.is_progressive_pass OR e.is_progressive_carry THEN 1 ELSE 0 END) AS prog_actions
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.team_name = ? AND e.player_name IS NOT NULL
        GROUP BY e.player_name, e.position_name
        ORDER BY (total_xg * 10 + key_passes * 2 + prog_actions * 0.25) DESC
        LIMIT 4
        """,
        [season, opp],
    ).fetchall()

    danger_players = [
        {
            "player_name": t[0],
            "position": t[1],
            "total_xg": float(t[2]),
            "key_passes": int(t[3]),
            "prog_actions": int(t[4]),
        }
        for t in threats
    ]

    formations_used = conn.execute(
        """
        SELECT formation, COUNT(*) AS cnt FROM (
            SELECT home_formation AS formation FROM matches WHERE season_name = ? AND home_team_name = ?
            UNION ALL
            SELECT away_formation AS formation FROM matches WHERE season_name = ? AND away_team_name = ?
        ) GROUP BY formation ORDER BY cnt DESC
        """,
        [season, opp, season, opp],
    ).fetchall()

    return {
        "module_id": "opposition_scouting_one_pager",
        "title": f"Opposition Scouting One-Pager — {opp} ({season})",
        "coord_grid": grid,
        "summary": (
            f"Pre-Match Briefing on {opp}: PPDA {opp_style['ppda']:.2f}, {opp_style['possession_share']:.1f}% possession, "
            f"{opp_style['build_up_directness']:.1f}% long build-up share, primary shape {formations_used[0][0] if formations_used else '4-3-3'}. "
            f"Key threat: {danger_players[0]['player_name'] if danger_players else 'N/A'}."
        ),
        "charts": {
            "style_kpis": opp_style,
            "formations": [{"formation": f[0], "matches": int(f[1])} for f in formations_used],
            "danger_players": danger_players,
        },
        "pitch": {
            "title": f"{opp} Pressing Intensity & Defensive Trigger Zones (Attacking Left → Right)",
            "zones": zones,
            "markers": [],
            "arrows": [],
        },
        "table_columns": ["match_state", "primary_shape", "events", "directness_pct", "prog_pass_share", "avg_def_line_m"],
        "table_rows": table_rows,
        "assumptions": cfg,
    }


def run_multi_season_player_progression(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 4: Multi-Season Player Progression
    Ranks qualifying players between two seasons across a chosen skill composite
    (ball_progression, box_threat, defensive_disruption, chance_creation) with PAdj/Per-90 options.
    """
    cfg = merge_assumptions(overrides)
    s1 = str(cfg["season_1"])
    s2 = str(cfg["season_2"])
    min_mins = int(cfg["min_minutes"])
    norm = str(cfg["normalisation"])
    composite = str(cfg["skill_composite"])
    grid = str(cfg["coord_grid"])

    # Compute player stats per season including team possession share for PAdj normalization
    rows = conn.execute(
        """
        WITH player_mins AS (
            SELECT m.season_name, l.player_id, l.player_name, MAX(l.team_name) AS team_name,
                   MAX(l.position_name) AS position_name, SUM(l.minutes_played) AS minutes_played
            FROM lineups l
            JOIN matches m ON l.match_id = m.match_id
            WHERE m.season_name IN (?, ?)
            GROUP BY m.season_name, l.player_id, l.player_name
            HAVING SUM(l.minutes_played) >= ?
        ),
        team_poss AS (
            SELECT m.season_name, p.team_name,
                   100.0 * SUM(CASE WHEN p.possession_team_name = p.team_name THEN 1 ELSE 0 END) / GREATEST(1, COUNT(*)) AS poss_pct
            FROM (
                SELECT DISTINCT e.match_id, e.possession, e.possession_team_name, l.team_name
                FROM events e
                JOIN (SELECT DISTINCT match_id, team_name FROM lineups) l ON e.match_id = l.match_id
            ) p
            JOIN matches m ON p.match_id = m.match_id
            WHERE m.season_name IN (?, ?)
            GROUP BY m.season_name, p.team_name
        ),
        player_events AS (
            SELECT m.season_name, e.player_id,
                   SUM(CASE WHEN e.is_progressive_pass THEN 1 ELSE 0 END) AS prog_passes,
                   SUM(CASE WHEN e.is_progressive_carry THEN 1 ELSE 0 END) AS prog_carries,
                   SUM(CASE WHEN e.is_box_entry THEN 1 ELSE 0 END) AS box_entries,
                   SUM(CASE WHEN e.event_type = 'Shot' THEN e.xg ELSE 0 END) AS xg,
                   SUM(CASE WHEN e.event_type = 'Shot' THEN 1 ELSE 0 END) AS shots,
                   SUM(CASE WHEN e.is_key_pass THEN 1 ELSE 0 END) AS key_passes,
                   SUM(CASE WHEN e.is_assist THEN 1 ELSE 0 END) AS assists,
                   SUM(CASE WHEN e.is_defensive_action THEN 1 ELSE 0 END) AS def_actions,
                   SUM(CASE WHEN e.is_high_turnover THEN 1 ELSE 0 END) AS high_turnovers
            FROM events e
            JOIN matches m ON e.match_id = m.match_id
            WHERE m.season_name IN (?, ?) AND e.player_id IS NOT NULL
            GROUP BY m.season_name, e.player_id
        )
        SELECT pm.season_name, pm.player_id, pm.player_name, pm.team_name, pm.position_name,
               pm.minutes_played, COALESCE(tp.poss_pct, 50.0) AS poss_pct,
               COALESCE(pe.prog_passes, 0), COALESCE(pe.prog_carries, 0), COALESCE(pe.box_entries, 0),
               COALESCE(pe.xg, 0), COALESCE(pe.shots, 0), COALESCE(pe.key_passes, 0),
               COALESCE(pe.assists, 0), COALESCE(pe.def_actions, 0), COALESCE(pe.high_turnovers, 0)
        FROM player_mins pm
        LEFT JOIN team_poss tp ON pm.season_name = tp.season_name AND pm.team_name = tp.team_name
        LEFT JOIN player_events pe ON pm.season_name = pe.season_name AND pm.player_id = pe.player_id
        """,
        [s1, s2, min_mins, s1, s2, s1, s2],
    ).fetchall()

    def _score_row(r: tuple[Any, ...]) -> tuple[float, dict[str, float]]:
        mins = max(1.0, float(r[5]))
        poss = float(r[6])
        padj_factor = (50.0 / max(20.0, 100.0 - poss)) if norm == "possession_adjusted" else 1.0
        scale90 = 90.0 / mins

        prog_p90 = float(r[7]) * scale90
        carry_p90 = float(r[8]) * scale90
        box_p90 = float(r[9]) * scale90
        xg_90 = float(r[10]) * scale90
        shots_90 = float(r[11]) * scale90
        kp_90 = float(r[12]) * scale90
        ast_90 = float(r[13]) * scale90
        def_90 = float(r[14]) * scale90 * padj_factor
        ht_90 = float(r[15]) * scale90 * padj_factor

        if composite == "box_threat":
            val = xg_90 * 12.0 + shots_90 * 1.4 + box_p90 * 0.65
        elif composite == "defensive_disruption":
            val = def_90 * 0.8 + ht_90 * 2.5
        elif composite == "chance_creation":
            val = kp_90 * 2.5 + ast_90 * 5.0 + box_p90 * 0.5
        else:  # ball_progression
            val = prog_p90 * 0.9 + carry_p90 * 0.7 + box_p90 * 0.8

        return round(val, 2), {
            "prog_passes_90": round(prog_p90, 2),
            "xg_90": round(xg_90, 2),
            "key_passes_90": round(kp_90, 2),
            "def_actions_90": round(def_90, 2),
        }

    by_player: dict[int, dict[str, Any]] = {}
    for r in rows:
        pid = int(r[1])
        score, detail = _score_row(r)
        entry = by_player.setdefault(
            pid,
            {
                "player_id": pid,
                "player_name": r[2],
                "team_name": r[3],
                "position": r[4],
            },
        )
        if r[0] == s1:
            entry["s1_score"] = score
            entry["season_1_minutes"] = int(r[5])
            entry["s1_detail"] = detail
        elif r[0] == s2:
            entry["s2_score"] = score
            entry["season_2_minutes"] = int(r[5])
            entry["s2_detail"] = detail

    ranked = []
    for pid, item in by_player.items():
        if "s1_score" in item and "s2_score" in item:
            delta = round(item["s2_score"] - item["s1_score"], 2)
            pct_change = round(100.0 * delta / max(0.2, item["s1_score"]), 1)
            ranked.append(
                {
                    "player_id": pid,
                    "player_name": item["player_name"],
                    "team_name": item["team_name"],
                    "position": item["position"],
                    "season_1_minutes": item["season_1_minutes"],
                    "season_2_minutes": item["season_2_minutes"],
                    "season_1_score": item["s1_score"],
                    "season_2_score": item["s2_score"],
                    "delta": delta,
                    "pct_change": pct_change,
                }
            )

    ranked.sort(key=lambda x: x["delta"], reverse=True)
    top_players = ranked[:15]

    # Pitch map for top improver's season_2 progressive passes & shots
    top_player_name = top_players[0]["player_name"] if top_players else ""
    markers = []
    arrows = []
    if top_player_name:
        ev_rows = conn.execute(
            """
            SELECT e.event_type, e.x, e.y, e.end_x, e.end_y, e.x_105, e.y_105, e.end_x_105, e.end_y_105, e.xg, e.outcome
            FROM events e
            JOIN matches m ON e.match_id = m.match_id
            WHERE m.season_name = ? AND e.player_name = ?
              AND (e.is_progressive_pass = TRUE OR e.event_type = 'Shot')
            LIMIT 50
            """,
            [s2, top_player_name],
        ).fetchall()
        for er in ev_rows:
            px, py = _coord_pair(er[1], er[2], er[5], er[6], grid)
            if er[0] == "Pass" and er[3] is not None:
                ex, ey = _coord_pair(er[3], er[4], er[7], er[8], grid)
                arrows.append({"x1": px, "y1": py, "x2": ex, "y2": ey, "color": "#a855f7", "label": f"{top_player_name} Prog Pass"})
            elif er[0] == "Shot":
                markers.append(
                    {
                        "x": px,
                        "y": py,
                        "radius": round(3.0 + float(er[9]) * 8.0, 2),
                        "color": "#10b981" if er[10] == "Goal" else "#f59e0b",
                        "label": f"{top_player_name} Shot (xG {er[9]:.2f})",
                        "group": er[10],
                    }
                )

    scouting_summary = (
        f"Across {len(ranked)} qualifying players (>= {min_mins} mins in both {s1} & {s2}, {norm} normalization), "
        f"{top_players[0]['player_name']} ({top_players[0]['team_name']}) led {composite.replace('_', ' ')} progression "
        f"with a {top_players[0]['delta']:+.2f} composite jump ({top_players[0]['season_1_score']:.2f} → {top_players[0]['season_2_score']:.2f})."
        if top_players
        else f"No players met the {min_mins} minute threshold in both {s1} and {s2}."
    )

    return {
        "module_id": "multi_season_player_progression",
        "title": f"Multi-Season Player Progression ({composite.replace('_', ' ').title()}: {s1} → {s2})",
        "coord_grid": grid,
        "summary": scouting_summary,
        "charts": {
            "leaderboard": top_players[:10],
            "composite": composite,
            "normalisation": norm,
            "total_qualifiers": len(ranked),
        },
        "pitch": {
            "title": f"Top Improver Action Map ({top_player_name or 'N/A'} — {s2})",
            "arrows": arrows[:30],
            "markers": markers[:30],
            "zones": [],
        },
        "table_columns": [
            "player_name",
            "team_name",
            "position",
            "season_1_minutes",
            "season_2_minutes",
            "season_1_score",
            "season_2_score",
            "delta",
            "pct_change",
        ],
        "table_rows": top_players,
        "assumptions": cfg,
    }


def run_tactical_fit_recruitment_matcher(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 5: Tactical Fit & Recruitment Matcher
    Compares a target player's current team style profile against the user's selected
    destination club across core tactical dimensions and highlights adaptation risks.
    """
    cfg = merge_assumptions(overrides)
    player_name = str(cfg["player_name"])
    target_club = str(cfg["target_club"])
    season = str(cfg["season_name"])
    grid = str(cfg["coord_grid"])

    p_row = conn.execute(
        "SELECT player_id, player_name, team_name, primary_position FROM players WHERE LOWER(player_name) LIKE LOWER(?) LIMIT 1",
        [f"%{player_name}%"],
    ).fetchone()
    if not p_row:
        p_row = conn.execute(
            "SELECT player_id, player_name, team_name, primary_position FROM players LIMIT 1"
        ).fetchone()

    resolved_player = str(p_row[1])
    current_club = str(p_row[2])
    player_pos = str(p_row[3])

    current_style = _compute_team_style_profile(conn, current_club, season, cfg)
    target_style = _compute_team_style_profile(conn, target_club, season, cfg)

    dims = [
        ("ppda", "Pressing Intensity (PPDA)", 20.0),
        ("possession_share", "Possession Share (%)", 40.0),
        ("build_up_directness", "Build-up Directness (%)", 35.0),
        ("high_turnovers_per90", "High Turnovers / 90", 6.0),
        ("progressive_passes_per90", "Progressive Passes / 90", 30.0),
        ("box_entries_per90", "Box Entries / 90", 15.0),
    ]

    radar_data = []
    table_rows = []
    diffs = []
    risks = []

    for key, label, scale in dims:
        c_val = current_style[key]
        t_val = target_style[key]
        gap = round(t_val - c_val, 2)
        norm_diff = min(1.0, abs(gap) / scale)
        overlap_pct = int(round((1.0 - norm_diff) * 100))
        diffs.append(norm_diff)
        radar_data.append(
            {
                "metric": label,
                "current_club_val": c_val,
                "target_club_val": t_val,
                "overlap_pct": overlap_pct,
            }
        )
        risk_flag = "High Adaptation Gap" if overlap_pct < 68 else ("Moderate Adjustment" if overlap_pct < 85 else "Strong Alignment")
        table_rows.append(
            {
                "dimension": label,
                "player_team_val": c_val,
                "target_club_val": t_val,
                "delta": gap,
                "overlap_pct": overlap_pct,
                "status": risk_flag,
            }
        )
        if overlap_pct < 78:
            risks.append(f"{label}: {current_club} averages {c_val} vs {target_club} at {t_val} ({overlap_pct}% overlap).")

    fit_score = int(round(max(25.0, min(99.0, 100.0 * (1.0 - sum(diffs) / len(diffs))))))
    if not risks:
        risks.append(f"Minimal tactical friction: {current_club} and {target_club} operate within 15% across all 6 style metrics.")

    # Player touch / progression footprint on pitch
    ev_rows = conn.execute(
        """
        SELECT e.event_type, e.x, e.y, e.end_x, e.end_y, e.x_105, e.y_105, e.end_x_105, e.end_y_105
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.player_name = ?
        LIMIT 80
        """,
        [season, resolved_player],
    ).fetchall()

    markers = []
    arrows = []
    for er in ev_rows:
        px, py = _coord_pair(er[1], er[2], er[5], er[6], grid)
        if er[0] == "Pass" and er[3] is not None and len(arrows) < 25:
            ex, ey = _coord_pair(er[3], er[4], er[7], er[8], grid)
            arrows.append({"x1": px, "y1": py, "x2": ex, "y2": ey, "color": "#22d3ee", "label": f"{resolved_player} Pass"})
        elif len(markers) < 35:
            markers.append(
                {
                    "x": px,
                    "y": py,
                    "radius": 3.5,
                    "color": "#10b981" if er[0] == "Shot" else "#94a3b8",
                    "label": f"{resolved_player} {er[0]}",
                    "group": er[0],
                }
            )

    return {
        "module_id": "tactical_fit_recruitment_matcher",
        "title": f"Tactical Fit Matcher — {resolved_player} ({current_club}) → {target_club}",
        "coord_grid": grid,
        "summary": (
            f"{resolved_player} ({player_pos}, {current_club}) achieves a {fit_score}% Tactical Fit Score for {target_club}. "
            + risks[0]
        ),
        "charts": {
            "fit_score": fit_score,
            "player_name": resolved_player,
            "current_club": current_club,
            "target_club": target_club,
            "radar": radar_data,
            "adaptation_risks": risks,
        },
        "pitch": {
            "title": f"{resolved_player} On-Ball Footprint & Passing Vectors ({season})",
            "markers": markers,
            "arrows": arrows,
            "zones": [],
        },
        "table_columns": ["dimension", "player_team_val", "target_club_val", "delta", "overlap_pct", "status"],
        "table_rows": table_rows,
        "assumptions": cfg,
    }


def _simulate_match_xpts(home_shots: list[float], away_shots: list[float]) -> tuple[float, float]:
    """
    Exact Poisson-binomial convolution over shot-level xG values to compute
    expected points (xPTS) for home and away clubs without Monte Carlo noise.
    """
    def _goal_dist(xgs: list[float]) -> list[float]:
        dist = [1.0]
        for p in xgs:
            p_c = max(0.0, min(0.99, float(p)))
            nxt = [0.0] * (len(dist) + 1)
            for k, prob in enumerate(dist):
                nxt[k] += prob * (1.0 - p_c)
                nxt[k + 1] += prob * p_c
            dist = nxt
        return dist

    hd = _goal_dist(home_shots)
    ad = _goal_dist(away_shots)
    p_hw = p_dr = p_aw = 0.0
    for hg, hp in enumerate(hd):
        for ag, ap in enumerate(ad):
            prob = hp * ap
            if hg > ag:
                p_hw += prob
            elif hg == ag:
                p_dr += prob
            else:
                p_aw += prob
    return (3.0 * p_hw + p_dr), (3.0 * p_aw + p_dr)


def run_league_table_vs_underlying_play(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 6: League Table vs Underlying Play
    Simulates shot-level xPTS across every match, plotting actual points vs xPTS
    and flagging overperforming / underperforming clubs.
    """
    cfg = merge_assumptions(overrides)
    season = str(cfg["season_name"])
    grid = str(cfg["coord_grid"])

    matches = conn.execute(
        """
        SELECT match_id, home_team_name, away_team_name, home_score, away_score
        FROM matches
        WHERE season_name = ?
        ORDER BY match_id
        """,
        [season],
    ).fetchall()

    shots = conn.execute(
        """
        SELECT e.match_id, e.team_name, e.xg
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.event_type = 'Shot'
        """,
        [season],
    ).fetchall()

    shot_map: dict[tuple[int, str], list[float]] = {}
    for mid, tname, xg in shots:
        shot_map.setdefault((int(mid), str(tname)), []).append(float(xg))

    standings: dict[str, dict[str, Any]] = {}
    for mid, hname, aname, hs, as_ in matches:
        mid = int(mid)
        hs, as_ = int(hs), int(as_)
        h_shots = shot_map.get((mid, hname), [])
        a_shots = shot_map.get((mid, aname), [])
        hxpts, axpts = _simulate_match_xpts(h_shots, a_shots)

        for name, gf, ga, xg_list, xga_list, xpts in (
            (hname, hs, as_, h_shots, a_shots, hxpts),
            (aname, as_, hs, a_shots, h_shots, axpts),
        ):
            rec = standings.setdefault(
                name,
                {"team_name": name, "mp": 0, "actual_pts": 0, "gf": 0, "ga": 0, "xgf": 0.0, "xga": 0.0, "xpts": 0.0},
            )
            rec["mp"] += 1
            rec["gf"] += gf
            rec["ga"] += ga
            rec["actual_pts"] += 3 if gf > ga else (1 if gf == ga else 0)
            rec["xgf"] += sum(xg_list)
            rec["xga"] += sum(xga_list)
            rec["xpts"] += xpts

    table_rows = []
    for rec in standings.values():
        xgf = round(rec["xgf"], 2)
        xga = round(rec["xga"], 2)
        xpts = round(rec["xpts"], 1)
        pts_diff = round(rec["actual_pts"] - xpts, 1)
        gd = rec["gf"] - rec["ga"]
        xgd = round(xgf - xga, 2)
        flag = (
            "Overperforming" if pts_diff >= 3.0
            else ("Underperforming" if pts_diff <= -3.0 else "On Par")
        )
        table_rows.append(
            {
                "team_name": rec["team_name"],
                "mp": rec["mp"],
                "actual_pts": rec["actual_pts"],
                "xpts": xpts,
                "pts_residual": pts_diff,
                "gf": rec["gf"],
                "ga": rec["ga"],
                "gd": gd,
                "xgf": xgf,
                "xga": xga,
                "xgd": xgd,
                "status": flag,
            }
        )

    table_rows.sort(key=lambda r: (r["actual_pts"], r["gd"]), reverse=True)
    for idx, r in enumerate(table_rows, start=1):
        r["actual_rank"] = idx

    xpts_sorted = sorted(table_rows, key=lambda r: (r["xpts"], r["xgd"]), reverse=True)
    for idx, r in enumerate(xpts_sorted, start=1):
        r["xpts_rank"] = idx

    overperf = max(table_rows, key=lambda r: r["pts_residual"]) if table_rows else None
    underperf = min(table_rows, key=lambda r: r["pts_residual"]) if table_rows else None

    return {
        "module_id": "league_table_vs_underlying_play",
        "title": f"League Table vs Underlying Play (Simulated xPTS — {season})",
        "coord_grid": grid,
        "summary": (
            f"Shot-level Poisson xPTS model across {len(matches)} matches ({season}): "
            f"{overperf['team_name']} leads overperformers ({overperf['pts_residual']:+.1f} pts vs xPTS) while "
            f"{underperf['team_name']} is the biggest underperformer ({underperf['pts_residual']:+.1f} pts vs xPTS)."
            if overperf and underperf
            else "No match data found."
        ),
        "charts": {
            "scatter": table_rows,
        },
        "pitch": {
            "title": f"League Shot Quality Landscape ({season})",
            "markers": [],
            "arrows": [],
            "zones": [],
        },
        "table_columns": [
            "actual_rank",
            "xpts_rank",
            "team_name",
            "mp",
            "actual_pts",
            "xpts",
            "pts_residual",
            "xgf",
            "xga",
            "xgd",
            "status",
        ],
        "table_rows": table_rows,
        "assumptions": cfg,
    }


def _classify_shot_zone_120(x: float, y: float) -> str:
    """Partition the attacking half (120x80) into 10 clean tactical shot zones."""
    if x >= 114.0 and 30.0 <= y <= 50.0:
        return "Six-Yard Box"
    if x >= 102.0 and 30.0 <= y <= 50.0:
        return "Central Penalty Area"
    if x >= 102.0 and 18.0 <= y < 30.0:
        return "Left Box Channel"
    if x >= 102.0 and 50.0 < y <= 62.0:
        return "Right Box Channel"
    if 93.0 <= x < 102.0 and 30.0 <= y <= 50.0:
        return "Box Edge (Zone 14)"
    if 93.0 <= x < 102.0 and 18.0 <= y < 30.0:
        return "Left Half-Space"
    if 93.0 <= x < 102.0 and 50.0 < y <= 62.0:
        return "Right Half-Space"
    if y < 18.0:
        return "Wide Left Wing"
    if y > 62.0:
        return "Wide Right Wing"
    return "Long Range Central"


def _zone_geometry(zone_name: str, grid: str) -> tuple[float, float, float, float]:
    """Return (x, y, width, height) for a shot zone in 120x80 or 105x68 coordinates."""
    boxes_120 = {
        "Six-Yard Box": (114.0, 30.0, 6.0, 20.0),
        "Central Penalty Area": (102.0, 30.0, 12.0, 20.0),
        "Left Box Channel": (102.0, 18.0, 12.0, 12.0),
        "Right Box Channel": (102.0, 50.0, 12.0, 12.0),
        "Box Edge (Zone 14)": (93.0, 30.0, 9.0, 20.0),
        "Left Half-Space": (93.0, 18.0, 9.0, 12.0),
        "Right Half-Space": (93.0, 50.0, 9.0, 12.0),
        "Wide Left Wing": (80.0, 0.0, 40.0, 18.0),
        "Wide Right Wing": (80.0, 62.0, 40.0, 18.0),
        "Long Range Central": (80.0, 18.0, 13.0, 44.0),
    }
    x, y, w, h = boxes_120[zone_name]
    if grid == "105x68":
        sx, sy = 105.0 / 120.0, 68.0 / 80.0
        return round(x * sx, 2), round(y * sy, 2), round(w * sx, 2), round(h * sy, 2)
    return x, y, w, h


def run_shot_location_zone_efficiency(
    conn: duckdb.DuckDBPyConnection,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Module 7: Shot Location & Zone Efficiency
    Interactive pitch heatmap & zonal grid comparing a team's shot volume,
    xG/shot, goal output, and conversion rates by zone against league averages.
    """
    cfg = merge_assumptions(overrides)
    team = str(cfg["team_name"])
    season = str(cfg["season_name"])
    grid = str(cfg["coord_grid"])

    rows = conn.execute(
        """
        SELECT e.team_name, e.x, e.y, e.x_105, e.y_105, e.xg, e.outcome, e.player_name, e.minute
        FROM events e
        JOIN matches m ON e.match_id = m.match_id
        WHERE m.season_name = ? AND e.event_type = 'Shot'
        """,
        [season],
    ).fetchall()

    zone_order = [
        "Six-Yard Box",
        "Central Penalty Area",
        "Left Box Channel",
        "Right Box Channel",
        "Box Edge (Zone 14)",
        "Left Half-Space",
        "Right Half-Space",
        "Wide Left Wing",
        "Wide Right Wing",
        "Long Range Central",
    ]
    team_acc: dict[str, dict[str, float]] = {z: {"shots": 0, "goals": 0, "xg": 0.0} for z in zone_order}
    lg_acc: dict[str, dict[str, float]] = {z: {"shots": 0, "goals": 0, "xg": 0.0} for z in zone_order}
    pitch_markers = []

    team_total_shots = 0
    lg_total_shots = len(rows)

    for r in rows:
        tname, x120, y80, x105, y68, xg, outcome, pname, minute = r
        z = _classify_shot_zone_120(float(x120), float(y80))
        is_goal = 1 if outcome == "Goal" else 0
        lg_acc[z]["shots"] += 1
        lg_acc[z]["goals"] += is_goal
        lg_acc[z]["xg"] += float(xg)

        if tname == team:
            team_total_shots += 1
            team_acc[z]["shots"] += 1
            team_acc[z]["goals"] += is_goal
            team_acc[z]["xg"] += float(xg)
            px, py = _coord_pair(float(x120), float(y80), float(x105), float(y68), grid)
            pitch_markers.append(
                {
                    "x": px,
                    "y": py,
                    "radius": round(2.8 + float(xg) * 9.0, 2),
                    "color": "#10b981" if is_goal else "#38bdf8",
                    "label": f"{pname} ({minute}'): xG {float(xg):.2f} [{outcome}] — {z}",
                    "group": "Goal" if is_goal else "Non-Goal Shot",
                }
            )

    table_rows = []
    zones = []
    max_z_shots = max([v["shots"] for v in team_acc.values()] or [1])

    for z in zone_order:
        t_s = int(team_acc[z]["shots"])
        t_g = int(team_acc[z]["goals"])
        t_xg = round(team_acc[z]["xg"], 2)
        t_xg_shot = round(t_xg / max(1, t_s), 3) if t_s else 0.0
        t_conv = round(100.0 * t_g / max(1, t_s), 1) if t_s else 0.0
        t_share = round(100.0 * t_s / max(1, team_total_shots), 1)

        l_s = int(lg_acc[z]["shots"])
        l_g = int(lg_acc[z]["goals"])
        l_xg = lg_acc[z]["xg"]
        l_xg_shot = round(l_xg / max(1, l_s), 3) if l_s else 0.0
        l_conv = round(100.0 * l_g / max(1, l_s), 1) if l_s else 0.0
        l_share = round(100.0 * l_s / max(1, lg_total_shots), 1)

        table_rows.append(
            {
                "zone": z,
                "team_shots": t_s,
                "shot_share_pct": t_share,
                "league_share_pct": l_share,
                "goals": t_g,
                "total_xg": t_xg,
                "xg_per_shot": t_xg_shot,
                "league_xg_per_shot": l_xg_shot,
                "conversion_pct": t_conv,
                "league_conversion_pct": l_conv,
            }
        )
        zx, zy, zw, zh = _zone_geometry(z, grid)
        zones.append(
            {
                "zone_id": z,
                "x": zx,
                "y": zy,
                "width": zw,
                "height": zh,
                "intensity": round(t_s / max(1, max_z_shots), 3),
                "value_label": f"{t_s} ({t_xg_shot:.2f})",
                "tooltip": f"{z}: {t_s} shots ({t_g} goals, {t_xg_shot:.2f} xG/shot vs {l_xg_shot:.2f} lg avg)",
            }
        )

    best_zone = max(table_rows, key=lambda r: r["goals"]) if table_rows else None
    return {
        "module_id": "shot_location_zone_efficiency",
        "title": f"Shot Location & Zone Efficiency — {team} vs League ({season})",
        "coord_grid": grid,
        "summary": (
            f"{team} took {team_total_shots} shots in {season}. Highest goal output came from "
            f"{best_zone['zone']} ({best_zone['goals']} goals from {best_zone['team_shots']} shots, "
            f"{best_zone['conversion_pct']:.1f}% conversion vs {best_zone['league_conversion_pct']:.1f}% league avg)."
            if best_zone
            else "No shot data found."
        ),
        "charts": {
            "zone_comparison": table_rows,
            "total_shots": team_total_shots,
        },
        "pitch": {
            "title": f"{team} Attacking Half Shot Zones & Shot Map ({grid} Grid)",
            "zones": zones,
            "markers": pitch_markers[:120],
            "arrows": [],
        },
        "table_columns": [
            "zone",
            "team_shots",
            "shot_share_pct",
            "league_share_pct",
            "goals",
            "total_xg",
            "xg_per_shot",
            "league_xg_per_shot",
            "conversion_pct",
            "league_conversion_pct",
        ],
        "table_rows": table_rows,
        "assumptions": cfg,
    }


MODULE_DISPATCH: dict[str, Any] = {
    "managerial_impact_tracker": run_managerial_impact_tracker,
    "tactical_intervention_comparison": run_tactical_intervention_comparison,
    "opposition_scouting_one_pager": run_opposition_scouting_one_pager,
    "multi_season_player_progression": run_multi_season_player_progression,
    "tactical_fit_recruitment_matcher": run_tactical_fit_recruitment_matcher,
    "league_table_vs_underlying_play": run_league_table_vs_underlying_play,
    "shot_location_zone_efficiency": run_shot_location_zone_efficiency,
}


def execute_module(
    conn: duckdb.DuckDBPyConnection,
    module_id: str,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Dispatch and execute one of the 7 analytical modules."""
    if module_id not in MODULE_DISPATCH:
        raise ValueError(f"Unknown analytical module '{module_id}'.")
    return MODULE_DISPATCH[module_id](conn, overrides)
