"""Canonical DuckDB schema, coordinate grid converters, and capability inspection."""

from __future__ import annotations

from typing import Any
import duckdb

CANONICAL_TABLES = ("matches", "teams", "players", "lineups", "events")

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS matches (
    match_id INTEGER PRIMARY KEY,
    competition_id INTEGER NOT NULL,
    competition_name VARCHAR NOT NULL,
    season_id INTEGER NOT NULL,
    season_name VARCHAR NOT NULL,
    match_date DATE NOT NULL,
    match_week INTEGER NOT NULL,
    home_team_id INTEGER NOT NULL,
    home_team_name VARCHAR NOT NULL,
    away_team_id INTEGER NOT NULL,
    away_team_name VARCHAR NOT NULL,
    home_score INTEGER NOT NULL,
    away_score INTEGER NOT NULL,
    home_manager VARCHAR NOT NULL,
    away_manager VARCHAR NOT NULL,
    home_formation VARCHAR NOT NULL,
    away_formation VARCHAR NOT NULL,
    stadium_name VARCHAR,
    referee_name VARCHAR,
    data_source VARCHAR NOT NULL DEFAULT 'statsbomb_open_data',
    coord_system VARCHAR NOT NULL DEFAULT '120x80'
);

CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY,
    team_name VARCHAR NOT NULL,
    country VARCHAR NOT NULL,
    gender VARCHAR NOT NULL DEFAULT 'male',
    manager_name VARCHAR NOT NULL,
    primary_formation VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY,
    player_name VARCHAR NOT NULL,
    nickname VARCHAR,
    team_id INTEGER NOT NULL,
    team_name VARCHAR NOT NULL,
    country VARCHAR NOT NULL,
    primary_position VARCHAR NOT NULL,
    position_group VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS lineups (
    match_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    team_name VARCHAR NOT NULL,
    player_id INTEGER NOT NULL,
    player_name VARCHAR NOT NULL,
    jersey_number INTEGER NOT NULL,
    position_name VARCHAR NOT NULL,
    is_starter BOOLEAN NOT NULL,
    minute_on INTEGER NOT NULL,
    minute_off INTEGER NOT NULL,
    minutes_played INTEGER NOT NULL,
    tactical_formation VARCHAR NOT NULL,
    PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS events (
    event_id VARCHAR PRIMARY KEY,
    match_id INTEGER NOT NULL,
    index_num INTEGER NOT NULL,
    period INTEGER NOT NULL,
    timestamp VARCHAR NOT NULL,
    minute INTEGER NOT NULL,
    second INTEGER NOT NULL,
    possession INTEGER NOT NULL,
    possession_team_id INTEGER NOT NULL,
    possession_team_name VARCHAR NOT NULL,
    team_id INTEGER NOT NULL,
    team_name VARCHAR NOT NULL,
    player_id INTEGER,
    player_name VARCHAR,
    position_name VARCHAR,
    event_type VARCHAR NOT NULL,
    outcome VARCHAR NOT NULL,
    x DOUBLE NOT NULL,
    y DOUBLE NOT NULL,
    end_x DOUBLE,
    end_y DOUBLE,
    x_105 DOUBLE NOT NULL,
    y_105 DOUBLE NOT NULL,
    end_x_105 DOUBLE,
    end_y_105 DOUBLE,
    xg DOUBLE DEFAULT 0.0,
    pass_length DOUBLE DEFAULT 0.0,
    pass_angle DOUBLE DEFAULT 0.0,
    pass_height VARCHAR,
    pass_recipient_id INTEGER,
    pass_recipient_name VARCHAR,
    is_key_pass BOOLEAN DEFAULT FALSE,
    is_assist BOOLEAN DEFAULT FALSE,
    is_progressive_pass BOOLEAN DEFAULT FALSE,
    is_box_entry BOOLEAN DEFAULT FALSE,
    is_progressive_carry BOOLEAN DEFAULT FALSE,
    carry_distance DOUBLE DEFAULT 0.0,
    is_defensive_action BOOLEAN DEFAULT FALSE,
    is_high_turnover BOOLEAN DEFAULT FALSE,
    is_counterpress BOOLEAN DEFAULT FALSE,
    under_pressure BOOLEAN DEFAULT FALSE,
    has_freeze_frame BOOLEAN DEFAULT FALSE,
    shot_body_part VARCHAR,
    shot_type VARCHAR,
    shot_technique VARCHAR,
    tactical_formation VARCHAR,
    match_state VARCHAR NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);
CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id);
CREATE INDEX IF NOT EXISTS idx_events_player ON events(player_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
"""


def init_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create canonical DuckDB tables and indexes if they do not exist."""
    conn.execute(SCHEMA_DDL)


def reset_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Drop and recreate all canonical tables cleanly."""
    for table in ("events", "lineups", "players", "teams", "matches"):
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    init_schema(conn)


def to_105x68(x_120: float | None, y_80: float | None) -> tuple[float | None, float | None]:
    """Convert StatsBomb 120x80 coordinates into FIFA/Metric 105x68 coordinates."""
    if x_120 is None or y_80 is None:
        return None, None
    x_clamped = max(0.0, min(120.0, float(x_120)))
    y_clamped = max(0.0, min(80.0, float(y_80)))
    return round(x_clamped * (105.0 / 120.0), 3), round(y_clamped * (68.0 / 80.0), 3)


def to_120x80_from_105x68(x_105: float | None, y_68: float | None) -> tuple[float | None, float | None]:
    """Convert FIFA/Metric 105x68 coordinates into StatsBomb 120x80 coordinates."""
    if x_105 is None or y_68 is None:
        return None, None
    x_clamped = max(0.0, min(105.0, float(x_105)))
    y_clamped = max(0.0, min(68.0, float(y_68)))
    return round(x_clamped * (120.0 / 105.0), 3), round(y_clamped * (80.0 / 68.0), 3)


def from_source_coords(
    x: float | None, y: float | None, source_grid: str
) -> tuple[float | None, float | None, float | None, float | None]:
    """
    Normalize coordinates from source_grid ('120x80', '105x68', '100x100', '1x1')
    into both canonical 120x80 and 105x68 pairs: (x_120, y_80, x_105, y_68).
    """
    if x is None or y is None:
        return None, None, None, None
    grid = source_grid.strip().lower()
    fx = float(x)
    fy = float(y)

    if grid == "120x80":
        x_120 = max(0.0, min(120.0, fx))
        y_80 = max(0.0, min(80.0, fy))
    elif grid == "105x68":
        x_120, y_80 = to_120x80_from_105x68(fx, fy)
    elif grid == "100x100":
        # Opta / Wyscout use 0-100 with y inverted relative to StatsBomb top-down origin
        x_120 = max(0.0, min(120.0, fx * 1.2))
        y_80 = max(0.0, min(80.0, (100.0 - fy) * 0.8))
    elif grid == "1x1":
        # Understat uses 0.0-1.0 normalized pitch coordinates
        x_120 = max(0.0, min(120.0, fx * 120.0))
        y_80 = max(0.0, min(80.0, fy * 80.0))
    else:
        x_120 = max(0.0, min(120.0, fx))
        y_80 = max(0.0, min(80.0, fy))

    x_105, y_68 = to_105x68(x_120, y_80)
    return round(x_120, 3), round(y_80, 3), x_105, y_68  # type: ignore[arg-type]


def inspect_database_capabilities(conn: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """
    Inspect live DuckDB schema, table counts, competition/season coverage,
    and explicit availability of specialized football data modalities for Stage 2 checks.
    """
    init_schema(conn)
    table_counts: dict[str, int] = {}
    table_columns: dict[str, list[str]] = {}

    for table in CANONICAL_TABLES:
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        table_counts[table] = int(count)
        cols = conn.execute(f"DESCRIBE {table}").fetchall()
        table_columns[table] = [row[0] for row in cols]

    competitions = [
        {
            "competition_id": int(r[0]),
            "competition_name": r[1],
            "season_id": int(r[2]),
            "season_name": r[3],
            "match_count": int(r[4]),
            "data_sources": r[5],
        }
        for r in conn.execute(
            """
            SELECT competition_id, competition_name, season_id, season_name,
                   COUNT(*) AS match_count,
                   STRING_AGG(DISTINCT data_source, ', ') AS data_sources
            FROM matches
            GROUP BY competition_id, competition_name, season_id, season_name
            ORDER BY season_name DESC, competition_name ASC
            """
        ).fetchall()
    ]

    teams = [
        {"team_id": int(r[0]), "team_name": r[1], "manager_name": r[2], "primary_formation": r[3]}
        for r in conn.execute(
            "SELECT team_id, team_name, manager_name, primary_formation FROM teams ORDER BY team_name"
        ).fetchall()
    ]

    players = [
        {
            "player_id": int(r[0]),
            "player_name": r[1],
            "team_name": r[2],
            "primary_position": r[3],
            "position_group": r[4],
        }
        for r in conn.execute(
            "SELECT player_id, player_name, team_name, primary_position, position_group FROM players ORDER BY team_name, player_name"
        ).fetchall()
    ]

    seasons = sorted({c["season_name"] for c in competitions})
    freeze_frame_count = conn.execute(
        "SELECT COUNT(*) FROM events WHERE has_freeze_frame = TRUE"
    ).fetchone()[0]

    date_bounds = conn.execute(
        "SELECT MIN(match_date)::VARCHAR, MAX(match_date)::VARCHAR FROM matches"
    ).fetchone()

    return {
        "table_counts": table_counts,
        "table_columns": table_columns,
        "competitions": competitions,
        "seasons": seasons,
        "teams": teams,
        "players": players,
        "date_range": {
            "min_date": date_bounds[0] if date_bounds else None,
            "max_date": date_bounds[1] if date_bounds else None,
        },
        "capabilities": {
            "has_events": table_counts["events"] > 0,
            "has_xg": table_counts["events"] > 0,
            "has_pass_coordinates": table_counts["events"] > 0,
            "has_carries": table_counts["events"] > 0,
            "has_pressures": table_counts["events"] > 0,
            "has_defensive_actions": table_counts["events"] > 0,
            "has_tactical_formations": table_counts["matches"] > 0,
            "has_multi_season": len(seasons) >= 2,
            "has_360_freeze_frames": int(freeze_frame_count) > 0,
            "freeze_frame_events": int(freeze_frame_count),
            # Explicit unavailable modalities for strict Stage 2 Feasibility Halts
            "has_tracking_data": False,
            "has_physical_sprint_speeds": False,
            "has_optical_body_pose": False,
            "has_expected_threat_tracking_offball": False,
            "has_biometric_heart_rate": False,
        },
    }
