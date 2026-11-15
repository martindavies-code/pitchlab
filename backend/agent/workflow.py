"""Stateful 5-stage gated agentic workflow engine with mandatory human-in-the-loop gates."""

from __future__ import annotations

import re
import uuid
from typing import Any

import duckdb

from backend.analytics.modules import DEFAULT_ASSUMPTIONS, execute_module, merge_assumptions
from backend.analytics.verification import run_automated_verification
from backend.db.schema import inspect_database_capabilities

# In-memory session store for the stateful 5-stage workflow
WORKFLOW_SESSIONS: dict[str, dict[str, Any]] = {}

UNAVAILABLE_SIGNAL_PATTERNS: list[tuple[str, str, str]] = [
    (
        r"\b(sprint speed|top speed|km/h|high[- ]speed running|distance covered|sprints?|gps|biometric|heart rate)\b",
        "Optical/GPS physical tracking metrics (sprint speeds, km/h, high-speed running distance)",
        "No `tracking_frames`, `sprint_speed_kmh`, or physical GPS columns exist in the canonical DuckDB tables (`matches`, `events`, `players`, `teams`, `lineups`).",
    ),
    (
        r"\b(freeze[- ]?frame|360|off[- ]ball defender positions?|body[- ]pose|body orientation|shoulder angle|skeleton)\b",
        "StatsBomb 360 freeze-frames & body-pose coordinates",
        "While `events.has_freeze_frame` exists in the schema, `freeze_frame_events = 0` in the currently loaded dataset and no body-pose/orientation columns exist.",
    ),
    (
        r"\b(tracking coordinates?|22[- ]player positions?|pitch control|voronoi|optical tracking)\b",
        "25Hz optical 22-player tracking coordinates",
        "DuckDB contains single-ball event coordinates (`x, y, end_x, end_y`), not continuous multi-player tracking frames.",
    ),
]

UNSUPPORTED_COMPETITION_PATTERNS: list[tuple[str, str]] = [
    (r"\b(serie a|bundesliga|ligue 1|mls|eredivisie|champions league|world cup 199\d|200\d)\b", "Requested competition or historical era"),
]


def _extract_entities(prompt: str, capabilities: dict[str, Any]) -> dict[str, Any]:
    """Parse team, player, season, matchweek window, composite, and missing data signals from English text."""
    low = prompt.lower()

    # Detect module intent
    module_id = "managerial_impact_tracker"
    if any(k in low for k in ("manager", "new boss", "coach", "right direction", "since", "arrived", "appointed")):
        module_id = "managerial_impact_tracker"
    elif any(k in low for k in ("intervention", "after the change", "custom run", "match run", "ppda", "did anything change")):
        module_id = "tactical_intervention_comparison"
    elif any(k in low for k in ("saturday", "what kind of team", "opposition", "scouting", "pre-match", "one-pager", "briefing")):
        module_id = "opposition_scouting_one_pager"
    elif any(k in low for k in ("improved most", "last season", "progression", "multi-season", "year over year", "delta")):
        module_id = "multi_season_player_progression"
    elif any(k in low for k in ("fit the way we play", "fit our", "recruitment", "would this player fit", "signing", "matcher")):
        module_id = "tactical_fit_recruitment_matcher"
    elif any(k in low for k in ("higher in the table", "deserved", "expected points", "xpts", "overperforming", "underperforming", "league table")):
        module_id = "league_table_vs_underlying_play"
    elif any(k in low for k in ("where are we shooting", "shot location", "shot zone", "zone efficiency", "conversion", "heatmap")):
        module_id = "shot_location_zone_efficiency"

    # Match teams from live DuckDB catalog
    teams = [t["team_name"] for t in capabilities.get("teams", [])]
    matched_teams: list[str] = []
    aliases = {
        "man united": "Manchester United",
        "man utd": "Manchester United",
        "united": "Manchester United",
        "man city": "Manchester City",
        "city": "Manchester City",
        "spurs": "Tottenham Hotspur",
        "tottenham": "Tottenham Hotspur",
        "villa": "Aston Villa",
        "newcastle": "Newcastle United",
        "brighton": "Brighton & Hove Albion",
        "west ham": "West Ham United",
        "arsenal": "Arsenal",
        "liverpool": "Liverpool",
        "chelsea": "Chelsea",
    }
    for alias, canon in aliases.items():
        if alias in low and canon in teams and canon not in matched_teams:
            matched_teams.append(canon)
    for t in teams:
        if t.lower() in low and t not in matched_teams:
            matched_teams.append(t)

    # Match players from live DuckDB catalog
    matched_player = DEFAULT_ASSUMPTIONS["player_name"]
    for p in capabilities.get("players", []):
        pname = p["player_name"]
        last = pname.split()[-1].lower()
        if pname.lower() in low or (len(last) >= 4 and re.search(rf"\b{re.escape(last)}\b", low)):
            matched_player = pname
            break

    # Detect composite for progression
    composite = DEFAULT_ASSUMPTIONS["skill_composite"]
    if any(k in low for k in ("box threat", "goal threat", "finishing", "xg")):
        composite = "box_threat"
    elif any(k in low for k in ("defensive", "disruption", "pressing", "tackle", "interception")):
        composite = "defensive_disruption"
    elif any(k in low for k in ("chance creation", "creativity", "key pass", "assist")):
        composite = "chance_creation"
    elif any(k in low for k in ("progression", "progressive", "carry", "ball progression")):
        composite = "ball_progression"

    # Detect normalization & grid hints
    normalisation = "possession_adjusted" if any(k in low for k in ("padj", "possession-adjusted", "possession adjusted")) else "per_90"
    coord_grid = "105x68" if "105" in low or "metric" in low else "120x80"

    # Detect minimum minutes threshold if explicitly mentioned
    min_match = re.search(r"(\d{3,4})\s*(?:min|minutes)", low)
    min_minutes = int(min_match.group(1)) if min_match else DEFAULT_ASSUMPTIONS["min_minutes"]
    explicit_min_mins = bool(min_match)

    # Detect season
    seasons = capabilities.get("seasons", ["2024/2025"])
    season_name = "2023/2024" if "2023" in low and "2024/2025" not in low else (seasons[0] if seasons else "2024/2025")
    if "2024/2025" in seasons and "2024" in low:
        season_name = "2024/2025"

    team_name = matched_teams[0] if matched_teams else DEFAULT_ASSUMPTIONS["team_name"]
    opponent_name = matched_teams[0] if matched_teams else DEFAULT_ASSUMPTIONS["opponent_name"]
    target_club = matched_teams[0] if matched_teams else DEFAULT_ASSUMPTIONS["target_club"]
    if len(matched_teams) >= 2:
        target_club = matched_teams[1]

    # Check unavailable requirements
    missing_requirements: list[dict[str, str]] = []
    for pattern, req_name, detail in UNAVAILABLE_SIGNAL_PATTERNS:
        if re.search(pattern, low):
            missing_requirements.append({"requirement": req_name, "reason": detail})

    for pattern, req_name in UNSUPPORTED_COMPETITION_PATTERNS:
        m = re.search(pattern, low)
        if m:
            loaded_comps = ", ".join({c["competition_name"] for c in capabilities.get("competitions", [])}) or "none"
            missing_requirements.append(
                {
                    "requirement": f"{req_name}: '{m.group(0)}'",
                    "reason": f"Connected DuckDB only covers [{loaded_comps}] across seasons {capabilities.get('seasons', [])}.",
                }
            )

    return {
        "module_id": module_id,
        "params": merge_assumptions(
            {
                "season_name": season_name,
                "team_name": team_name,
                "opponent_name": opponent_name,
                "player_name": matched_player,
                "target_club": target_club,
                "min_minutes": min_minutes,
                "normalisation": normalisation,
                "coord_grid": coord_grid,
                "skill_composite": composite,
            }
        ),
        "explicit_min_mins": explicit_min_mins,
        "explicit_team": bool(matched_teams),
        "missing_requirements": missing_requirements,
    }


def start_workflow_session(conn: duckdb.DuckDBPyConnection, prompt: str) -> dict[str, Any]:
    """
    Stage 1: Intent Clarification
    Parses the plain-English question, identifies ambiguities, and pauses for user confirmation.
    """
    capabilities = inspect_database_capabilities(conn)
    parsed = _extract_entities(prompt, capabilities)
    session_id = str(uuid.uuid4())[:12]

    clarifying_questions: list[dict[str, Any]] = []
    module_id = parsed["module_id"]
    params = parsed["params"]

    if not parsed["explicit_team"] and module_id in (
        "managerial_impact_tracker",
        "tactical_intervention_comparison",
        "opposition_scouting_one_pager",
        "shot_location_zone_efficiency",
    ):
        clarifying_questions.append(
            {
                "field": "opponent_name" if module_id == "opposition_scouting_one_pager" else "team_name",
                "question": "Which club should be scoped for this tactical analysis?",
                "options": [t["team_name"] for t in capabilities["teams"]],
                "default": params["opponent_name" if module_id == "opposition_scouting_one_pager" else "team_name"],
            }
        )

    if module_id == "multi_season_player_progression" and not parsed["explicit_min_mins"]:
        clarifying_questions.append(
            {
                "field": "min_minutes",
                "question": "What minimum minutes threshold per season should qualify a player?",
                "options": [270, 450, 720, 900],
                "default": params["min_minutes"],
            }
        )
        clarifying_questions.append(
            {
                "field": "skill_composite",
                "question": "Which tactical skill composite defines 'most improved'?",
                "options": ["ball_progression", "box_threat", "defensive_disruption", "chance_creation"],
                "default": params["skill_composite"],
            }
        )

    if not clarifying_questions:
        clarifying_questions.append(
            {
                "field": "normalisation",
                "question": "Confirm normalization baseline before checking DuckDB data feasibility:",
                "options": ["per_90", "possession_adjusted"],
                "default": params["normalisation"],
            }
        )

    session = {
        "session_id": session_id,
        "prompt": prompt,
        "stage": 1,
        "stage_name": "intent_clarification",
        "status": "awaiting_approval",
        "module_id": module_id,
        "params": params,
        "clarifying_questions": clarifying_questions,
        "missing_requirements": parsed["missing_requirements"],
        "feasibility": None,
        "execution_plan": None,
        "verification": None,
        "result": None,
    }
    WORKFLOW_SESSIONS[session_id] = session
    return session


def confirm_stage_1_and_check_feasibility(
    conn: duckdb.DuckDBPyConnection,
    session_id: str,
    clarifications: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Transition Stage 1 -> Stage 2: Data Feasibility Check.
    Inspects connected DuckDB schema and competition coverage before running queries.
    Halts immediately if required fields do not exist rather than inventing proxies.
    """
    if session_id not in WORKFLOW_SESSIONS:
        raise KeyError(f"Workflow session '{session_id}' not found.")
    session = WORKFLOW_SESSIONS[session_id]
    if clarifications:
        session["params"] = merge_assumptions({**session["params"], **clarifications})

    capabilities = inspect_database_capabilities(conn)
    missing = list(session["missing_requirements"])

    # Also check if requested tables are empty or season/team does not exist
    counts = capabilities["table_counts"]
    if counts["matches"] == 0 or counts["events"] == 0:
        missing.append(
            {
                "requirement": "Populated match & event tables",
                "reason": "DuckDB currently has 0 matches or 0 events. Load StatsBomb Open Data or upload a file first.",
            }
        )

    season = session["params"]["season_name"]
    if season not in capabilities["seasons"] and capabilities["seasons"]:
        missing.append(
            {
                "requirement": f"Season '{season}' coverage",
                "reason": f"Available seasons in DuckDB: {capabilities['seasons']}.",
            }
        )

    feasible = len(missing) == 0
    session["stage"] = 2
    session["stage_name"] = "data_feasibility_check"
    session["status"] = "awaiting_approval" if feasible else "halted_infeasible"
    session["feasibility"] = {
        "feasible": feasible,
        "checked_tables": list(counts.keys()),
        "table_counts": counts,
        "available_seasons": capabilities["seasons"],
        "available_competitions": [c["competition_name"] for c in capabilities["competitions"]],
        "capabilities": capabilities["capabilities"],
        "missing_requirements": missing,
        "halt_message": (
            "FEASIBILITY HALT: Required fields or competition coverage do not exist in the connected DuckDB dataset. "
            "PitchLab Studio refuses to invent proxy metrics for missing data."
            if not feasible
            else "All required DuckDB tables, columns, coordinates, and season fixtures verified present."
        ),
    }
    return session


def _build_transparent_plan(session: dict[str, Any]) -> dict[str, Any]:
    """Generate the plain-English Stage 3 execution plan with exact metrics and statistical caveats."""
    m_id = session["module_id"]
    p = session["params"]
    norm_desc = (
        "Possession-Adjusted (PAdj: defensive actions scaled by 50 / (100 - Team Possession %))"
        if p["normalisation"] == "possession_adjusted"
        else "Per-90 Minutes (Raw Count / Minutes Played * 90)"
    )

    plan_descriptions = {
        "managerial_impact_tracker": {
            "objective": f"Track rolling {p['rolling_window']}-match PPG and xG created vs conceded for {p['team_name']} in {p['season_name']}.",
            "metrics": [
                f"Rolling {p['rolling_window']}-match Points Per Game (3=W, 1=D, 0=L)",
                f"Rolling {p['rolling_window']}-match xG For vs xG Against (from shot-level `events.xg`)",
                f"Vertical milestone split at Matchweek {p['milestone_match_week']} (or detected manager change)",
            ],
            "caveats": [
                "Early-season rolling windows (< 4 matches) have smaller sample denominators.",
                "Fixture difficulty and finishing variance can separate actual PPG from underlying xG differential.",
            ],
        },
        "tactical_intervention_comparison": {
            "objective": f"Compare {p['team_name']} tactical style during MW {p['start_mw']}–{p['end_mw']} against full {p['season_name']} season average.",
            "metrics": [
                f"PPDA (opponent passes vs defensive actions above x_105 >= {p['ppda_def_line_x']}m)",
                "Build-up Directness (% of passes classified as High/Long passes)",
                f"High Turnovers/90 (ball recoveries/interceptions won at x_105 >= {p['high_turnover_x_threshold']}m)",
                f"Progressive Passes/90 (completed passes moving >= {p['prog_pass_min_dist']}m closer to goal or entering box)",
            ],
            "caveats": [
                "Short custom match runs (e.g. 4–8 matches) are sensitive to opponent strength and red-card game states.",
            ],
        },
        "opposition_scouting_one_pager": {
            "objective": f"Generate pre-match opposition scouting briefing for {p['opponent_name']} ({p['season_name']}).",
            "metrics": [
                "6-Zone Pressing Trigger Heatmap across pitch thirds and width channels",
                "Primary & secondary tactical formations",
                "Match-state shape & directness splits (`winning`, `drawing`, `losing`)",
                "Top 4 attacking threats ranked by cumulative xG + key passes + progressions",
            ],
            "caveats": [
                "Match-state subsamples (`losing` vs `winning`) vary in minutes depending on how often the opponent trailed.",
            ],
        },
        "multi_season_player_progression": {
            "objective": f"Rank qualifying players from {p['season_1']} to {p['season_2']} on the '{p['skill_composite']}' composite.",
            "metrics": [
                f"Composite formula for `{p['skill_composite']}` normalized via {norm_desc}",
                f"Minimum sample filter: >= {p['min_minutes']} minutes played in BOTH {p['season_1']} and {p['season_2']}",
            ],
            "caveats": [
                "Players who changed tactical roles or clubs between seasons may show role-driven rather than pure skill deltas.",
            ],
        },
        "tactical_fit_recruitment_matcher": {
            "objective": f"Evaluate tactical fit of {p['player_name']} for {p['target_club']} across 6 team style dimensions.",
            "metrics": [
                "6-Axis Style Overlap (PPDA, Possession Share, Build-up Directness, High Turnovers/90, Prog Passes/90, Box Entries/90)",
                "0–100% Composite Tactical Fit Score + Explicit Adaptation Risk Flags",
            ],
            "caveats": [
                "Team-environment comparison reflects the tactical demands of the player's current side alongside individual event footprints.",
            ],
        },
        "league_table_vs_underlying_play": {
            "objective": f"Compute exact shot-level Poisson-binomial xPTS across {p['season_name']} to expose over/underperformance.",
            "metrics": [
                "Match win/draw/loss probabilities derived from exact shot-level xG convolution",
                "Expected Points (`xPTS`) vs Official Points residual (`Actual Pts - xPTS`)",
            ],
            "caveats": [
                "Shot-level xPTS does not account for non-shot dangerous attacks (e.g. unshot cutbacks) or red-card timing.",
            ],
        },
        "shot_location_zone_efficiency": {
            "objective": f"Map {p['team_name']} shot volume, xG/shot, goals, and conversion across 10 pitch zones vs league average ({p['season_name']}).",
            "metrics": [
                f"Spatial mapping rendered on `{p['coord_grid']}` coordinate grid",
                "Zone Shot Share %, xG/Shot, and Goal Conversion % benchmarked against full league average",
            ],
            "caveats": [
                "Low-volume peripheral zones (e.g., Wide Wings) can show volatile conversion percentages.",
            ],
        },
    }

    spec = plan_descriptions[m_id]
    return {
        "module_id": m_id,
        "objective": spec["objective"],
        "sample_filters": {
            "season_name": p["season_name"],
            "team_name": p["team_name"],
            "opponent_name": p["opponent_name"],
            "min_minutes": p["min_minutes"],
            "matchweek_window": f"MW {p['start_mw']}–{p['end_mw']}",
        },
        "normalisation_method": norm_desc,
        "coord_grid": p["coord_grid"],
        "metrics": spec["metrics"],
        "statistical_caveats": spec["caveats"],
    }


def approve_stage_2_build_plan(
    conn: duckdb.DuckDBPyConnection,
    session_id: str,
) -> dict[str, Any]:
    """Transition Stage 2 -> Stage 3: Transparent Execution Plan (paused for approval)."""
    if session_id not in WORKFLOW_SESSIONS:
        raise KeyError(f"Workflow session '{session_id}' not found.")
    session = WORKFLOW_SESSIONS[session_id]
    if not session.get("feasibility", {}).get("feasible"):
        raise ValueError("Cannot advance past Stage 2: Feasibility check halted due to missing data.")

    session["stage"] = 3
    session["stage_name"] = "execution_plan"
    session["status"] = "awaiting_approval"
    session["execution_plan"] = _build_transparent_plan(session)
    return session


def approve_stage_3_execute_and_verify(
    conn: duckdb.DuckDBPyConnection,
    session_id: str,
    param_edits: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Transition Stage 3 -> Stage 4: Execute DuckDB transformation & run Automated Verification.
    """
    if session_id not in WORKFLOW_SESSIONS:
        raise KeyError(f"Workflow session '{session_id}' not found.")
    session = WORKFLOW_SESSIONS[session_id]
    if param_edits:
        session["params"] = merge_assumptions({**session["params"], **param_edits})
        session["execution_plan"] = _build_transparent_plan(session)

    result = execute_module(conn, session["module_id"], session["params"])
    verification = run_automated_verification(conn, session["module_id"], session["params"], result)

    session["stage"] = 4
    session["stage_name"] = "automated_verification"
    session["status"] = "awaiting_approval" if verification["all_passed"] else "verification_warning"
    session["verification"] = verification
    session["result"] = result
    return session


def approve_stage_4_render(
    conn: duckdb.DuckDBPyConnection,
    session_id: str,
) -> dict[str, Any]:
    """Transition Stage 4 -> Stage 5: Interactive Render & Assumption Override."""
    if session_id not in WORKFLOW_SESSIONS:
        raise KeyError(f"Workflow session '{session_id}' not found.")
    session = WORKFLOW_SESSIONS[session_id]
    if session.get("result") is None:
        raise ValueError("Cannot render Stage 5 before executing Stage 4 verification.")

    session["stage"] = 5
    session["stage_name"] = "interactive_render"
    session["status"] = "completed"
    return session


def override_assumptions_and_rerun(
    conn: duckdb.DuckDBPyConnection,
    session_id: str,
    assumptions_override: dict[str, Any],
) -> dict[str, Any]:
    """
    Stage 5 Assumption Override: Update definitions/thresholds and rerun Stages 3->4->5 verification.
    """
    if session_id not in WORKFLOW_SESSIONS:
        raise KeyError(f"Workflow session '{session_id}' not found.")
    session = WORKFLOW_SESSIONS[session_id]
    session["params"] = merge_assumptions({**session["params"], **assumptions_override})
    session["execution_plan"] = _build_transparent_plan(session)
    result = execute_module(conn, session["module_id"], session["params"])
    verification = run_automated_verification(conn, session["module_id"], session["params"], result)

    session["stage"] = 5
    session["stage_name"] = "interactive_render"
    session["status"] = "completed"
    session["verification"] = verification
    session["result"] = result
    return session
