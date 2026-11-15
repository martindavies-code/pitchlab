"""CSV and Parquet file importer with column-mapping presets for Wyscout, Opta, FBref, and Understat."""

from __future__ import annotations

import io
import math
from typing import Any

import duckdb
import pandas as pd

from backend.db.schema import from_source_coords, init_schema

PROVIDER_MAPPING_PRESETS: dict[str, dict[str, Any]] = {
    "wyscout": {
        "coord_system": "100x100",
        "columns": {
            "event_id": "id",
            "match_id": "matchId",
            "minute": "matchTimestamp",
            "team_name": "teamName",
            "player_name": "playerName",
            "event_type": "typePrimary",
            "outcome": "outcome",
            "x": "locationX",
            "y": "locationY",
            "end_x": "passEndLocationX",
            "end_y": "passEndLocationY",
            "xg": "shotXg",
        },
    },
    "opta": {
        "coord_system": "100x100",
        "columns": {
            "event_id": "event_id",
            "match_id": "match_id",
            "minute": "min",
            "team_name": "team_name",
            "player_name": "player_name",
            "event_type": "type_name",
            "outcome": "outcome",
            "x": "x",
            "y": "y",
            "end_x": "end_x",
            "end_y": "end_y",
            "xg": "xG",
        },
    },
    "fbref": {
        "coord_system": "120x80",
        "columns": {
            "event_id": "event_id",
            "match_id": "match_id",
            "minute": "Minute",
            "team_name": "Squad",
            "player_name": "Player",
            "event_type": "Event",
            "outcome": "Outcome",
            "x": "X",
            "y": "Y",
            "end_x": "EndX",
            "end_y": "EndY",
            "xg": "xG",
        },
    },
    "understat": {
        "coord_system": "1x1",
        "columns": {
            "event_id": "id",
            "match_id": "match_id",
            "minute": "minute",
            "team_name": "team",
            "player_name": "player",
            "event_type": "result",
            "outcome": "result",
            "x": "X",
            "y": "Y",
            "xg": "xG",
        },
    },
}


def read_uploaded_dataframe(file_bytes: bytes, filename: str) -> pd.DataFrame:
    """Parse uploaded CSV or Parquet bytes into a Pandas DataFrame."""
    lower = filename.lower()
    if lower.endswith(".parquet") or lower.endswith(".pq"):
        return pd.read_parquet(io.BytesIO(file_bytes))
    if lower.endswith(".csv"):
        return pd.read_csv(io.BytesIO(file_bytes))
    raise ValueError(f"Unsupported file format for '{filename}'. Upload .csv or .parquet files.")


def preview_uploaded_file(file_bytes: bytes, filename: str) -> dict[str, Any]:
    """Inspect columns, row count, sample rows, and auto-suggested vendor preset."""
    df = read_uploaded_dataframe(file_bytes, filename)
    cols = [str(c) for c in df.columns]
    col_set = set(cols)

    suggested_preset = "opta"
    for preset_name, cfg in PROVIDER_MAPPING_PRESETS.items():
        preset_cols = set(cfg["columns"].values())
        if len(col_set & preset_cols) >= 4:
            suggested_preset = preset_name
            break

    sample = df.head(5).fillna("").to_dict(orient="records")
    return {
        "filename": filename,
        "row_count": int(len(df)),
        "columns": cols,
        "suggested_preset": suggested_preset,
        "presets": PROVIDER_MAPPING_PRESETS,
        "sample_rows": sample,
    }


def _safe_float(val: Any, default: float | None = None) -> float | None:
    if val is None or val == "" or (isinstance(val, float) and math.isnan(val)):
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def ingest_mapped_dataframe(
    conn: duckdb.DuckDBPyConnection,
    df: pd.DataFrame,
    column_mapping: dict[str, str],
    coord_system: str = "100x100",
    data_source: str = "custom_upload",
    season_name: str = "2024/2025",
    competition_name: str = "Imported Feed",
) -> dict[str, Any]:
    """
    Map arbitrary vendor CSV/Parquet rows into canonical DuckDB events, teams, players, and matches.
    """
    init_schema(conn)

    # Resolve team name -> ID map from existing DuckDB teams
    existing_teams = {
        row[1].lower(): int(row[0])
        for row in conn.execute("SELECT team_id, team_name FROM teams").fetchall()
    }
    next_team_id = (
        conn.execute("SELECT COALESCE(MAX(team_id), 100) + 1 FROM teams").fetchone()[0]
    )
    existing_players = {
        row[1].lower(): int(row[0])
        for row in conn.execute("SELECT player_id, player_name FROM players").fetchall()
    }
    next_player_id = (
        conn.execute("SELECT COALESCE(MAX(player_id), 5000) + 1 FROM players").fetchone()[0]
    )

    events_to_insert: list[dict[str, Any]] = []
    new_teams: list[dict[str, Any]] = []
    new_players: list[dict[str, Any]] = []
    match_goals: dict[int, dict[str, int]] = {}
    match_teams: dict[int, list[tuple[int, str]]] = {}

    for row_idx, row in df.iterrows():
        def _get(canon_field: str, fallback: Any = None) -> Any:
            src_col = column_mapping.get(canon_field)
            if src_col and src_col in row and pd.notna(row[src_col]):
                return row[src_col]
            return fallback

        raw_match_id = _get("match_id", 990001)
        try:
            match_id = int(raw_match_id)
        except (TypeError, ValueError):
            match_id = 990000 + (abs(hash(str(raw_match_id))) % 10000)

        team_name = str(_get("team_name", "Imported FC")).strip() or "Imported FC"
        if team_name.lower() not in existing_teams:
            existing_teams[team_name.lower()] = int(next_team_id)
            new_teams.append(
                {
                    "team_id": int(next_team_id),
                    "team_name": team_name,
                    "country": "Imported",
                    "gender": "male",
                    "manager_name": "Head Coach",
                    "primary_formation": "4-3-3",
                }
            )
            next_team_id += 1
        team_id = existing_teams[team_name.lower()]

        player_name = str(_get("player_name", "Unknown Player")).strip() or "Unknown Player"
        if player_name.lower() not in existing_players:
            existing_players[player_name.lower()] = int(next_player_id)
            new_players.append(
                {
                    "player_id": int(next_player_id),
                    "player_name": player_name,
                    "nickname": player_name.split()[-1],
                    "team_id": team_id,
                    "team_name": team_name,
                    "country": "Imported",
                    "primary_position": "Midfielder",
                    "position_group": "MF",
                }
            )
            next_player_id += 1
        player_id = existing_players[player_name.lower()]

        raw_type = str(_get("event_type", "Pass")).strip()
        raw_outcome = str(_get("outcome", "Complete")).strip()
        # Normalize Understat shot result format automatically
        if raw_type.lower() in ("goal", "savedshot", "missedshots", "shotonpost", "blockedshot"):
            if raw_type.lower() == "goal":
                raw_outcome = "Goal"
            elif raw_type.lower() == "savedshot":
                raw_outcome = "Saved"
            elif raw_type.lower() == "blockedshot":
                raw_outcome = "Blocked"
            else:
                raw_outcome = "Off T"
            raw_type = "Shot"

        raw_x = _safe_float(_get("x"), 60.0)
        raw_y = _safe_float(_get("y"), 40.0)
        raw_ex = _safe_float(_get("end_x"), None)
        raw_ey = _safe_float(_get("end_y"), None)

        x_120, y_80, x_105, y_105 = from_source_coords(raw_x, raw_y, coord_system)
        ex_120, ey_80, ex_105, ey_105 = from_source_coords(raw_ex, raw_ey, coord_system)

        xg = float(_safe_float(_get("xg"), 0.0) or 0.0)
        minute_raw = _get("minute", 1)
        try:
            minute = int(str(minute_raw).split(":")[0])
        except (TypeError, ValueError):
            minute = 1

        match_teams.setdefault(match_id, [])
        if (team_id, team_name) not in match_teams[match_id]:
            match_teams[match_id].append((team_id, team_name))
        match_goals.setdefault(match_id, {})
        if raw_type == "Shot" and raw_outcome.lower() == "goal":
            match_goals[match_id][team_name] = match_goals[match_id].get(team_name, 0) + 1

        is_prog_pass = False
        is_box = False
        if raw_type == "Pass" and raw_outcome.lower() in ("complete", "1", "true", "accurate") and ex_105 is not None and ey_105 is not None:
            d0 = math.hypot(105.0 - x_105, 34.0 - y_105)
            d1 = math.hypot(105.0 - ex_105, 34.0 - ey_105)
            is_prog_pass = (d0 - d1) >= 10.0
            is_box = ex_105 >= 88.5 and 13.84 <= ey_105 <= 54.16 and x_105 < 88.5
            raw_outcome = "Complete"

        event_id = str(_get("event_id", f"imp_{match_id}_{row_idx}"))
        events_to_insert.append(
            {
                "event_id": event_id,
                "match_id": match_id,
                "index_num": int(row_idx) + 1,
                "period": 1 if minute <= 45 else 2,
                "timestamp": f"{minute:02d}:00.000",
                "minute": minute,
                "second": 0,
                "possession": int(row_idx) // 3 + 1,
                "possession_team_id": team_id,
                "possession_team_name": team_name,
                "team_id": team_id,
                "team_name": team_name,
                "player_id": player_id,
                "player_name": player_name,
                "position_name": "Imported",
                "event_type": raw_type,
                "outcome": raw_outcome,
                "x": x_120,
                "y": y_80,
                "end_x": ex_120,
                "end_y": ey_80,
                "x_105": x_105,
                "y_105": y_105,
                "end_x_105": ex_105,
                "end_y_105": ey_105,
                "xg": xg,
                "pass_length": round(math.hypot((ex_105 or x_105) - x_105, (ey_105 or y_105) - y_105), 2),
                "pass_angle": 0.0,
                "pass_height": "Ground Pass",
                "pass_recipient_id": None,
                "pass_recipient_name": None,
                "is_key_pass": False,
                "is_assist": False,
                "is_progressive_pass": is_prog_pass,
                "is_box_entry": is_box,
                "is_progressive_carry": False,
                "carry_distance": 0.0,
                "is_defensive_action": raw_type in ("Tackle", "Interception", "Pressure", "Duel", "Ball Recovery"),
                "is_high_turnover": raw_type in ("Interception", "Ball Recovery") and (x_105 or 0.0) >= 65.0,
                "is_counterpress": False,
                "under_pressure": False,
                "has_freeze_frame": False,
                "shot_body_part": "Right Foot" if raw_type == "Shot" else None,
                "shot_type": "Open Play" if raw_type == "Shot" else None,
                "shot_technique": "Normal" if raw_type == "Shot" else None,
                "tactical_formation": "4-3-3",
                "match_state": "drawing",
            }
        )

    existing_match_ids = {
        int(r[0]) for r in conn.execute("SELECT match_id FROM matches").fetchall()
    }
    new_matches = []
    for mid, tlist in match_teams.items():
        if mid in existing_match_ids:
            continue
        h_id, h_name = tlist[0]
        a_id, a_name = tlist[1] if len(tlist) > 1 else (h_id + 900, "Imported Opponent")
        new_matches.append(
            {
                "match_id": mid,
                "competition_id": 999,
                "competition_name": competition_name,
                "season_id": 999,
                "season_name": season_name,
                "match_date": "2025-01-15",
                "match_week": 1,
                "home_team_id": h_id,
                "home_team_name": h_name,
                "away_team_id": a_id,
                "away_team_name": a_name,
                "home_score": match_goals.get(mid, {}).get(h_name, 0),
                "away_score": match_goals.get(mid, {}).get(a_name, 0),
                "home_manager": "Head Coach",
                "away_manager": "Head Coach",
                "home_formation": "4-3-3",
                "away_formation": "4-3-3",
                "stadium_name": "Imported Stadium",
                "referee_name": "Match Official",
                "data_source": data_source,
                "coord_system": coord_system,
            }
        )

    for tbl_name, rows in (
        ("teams", new_teams),
        ("players", new_players),
        ("matches", new_matches),
        ("events", events_to_insert),
    ):
        if rows:
            ins_df = pd.DataFrame(rows)
            conn.register("_tmp_imp_df", ins_df)
            conn.execute(f"INSERT OR REPLACE INTO {tbl_name} SELECT * FROM _tmp_imp_df")
            conn.unregister("_tmp_imp_df")

    return {
        "status": "ok",
        "data_source": data_source,
        "coord_system": coord_system,
        "events_ingested": len(events_to_insert),
        "new_matches_created": len(new_matches),
        "new_teams_created": len(new_teams),
        "new_players_created": len(new_players),
    }
