"""Synthesize a concise, data-grounded football conclusion paragraph from analytical outputs."""

from __future__ import annotations

import re
from typing import Any

_UNSET = object()

CANONICAL_TEAMS: list[str] = [
    "Arsenal",
    "Aston Villa",
    "Brighton & Hove Albion",
    "Chelsea",
    "Liverpool",
    "Manchester City",
    "Manchester United",
    "Newcastle United",
    "Tottenham Hotspur",
    "West Ham United",
]

# Unambiguous club names and specific aliases only. Generic terms such as "united" or "city"
# are handled separately as ambiguous candidates rather than silently mapped to Manchester clubs.
SPECIFIC_CLUB_ALIASES: dict[str, str] = {
    "brighton & hove albion": "Brighton & Hove Albion",
    "brighton and hove albion": "Brighton & Hove Albion",
    "tottenham hotspur": "Tottenham Hotspur",
    "manchester united": "Manchester United",
    "newcastle united": "Newcastle United",
    "manchester city": "Manchester City",
    "west ham united": "West Ham United",
    "aston villa": "Aston Villa",
    "man united": "Manchester United",
    "man utd": "Manchester United",
    "man city": "Manchester City",
    "newcastle": "Newcastle United",
    "tottenham": "Tottenham Hotspur",
    "west ham": "West Ham United",
    "brighton": "Brighton & Hove Albion",
    "arsenal": "Arsenal",
    "chelsea": "Chelsea",
    "liverpool": "Liverpool",
    "spurs": "Tottenham Hotspur",
    "villa": "Aston Villa",
}


def _clean_metric_label(label: str) -> str:
    return re.sub(r"\s*\((?:%|Lower PPDA)\)", "", label).strip()


def _ordinal(n: int) -> str:
    n_abs = abs(int(n))
    if 11 <= (n_abs % 100) <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n_abs % 10, "th")
    return f"{int(n)}{suffix}"


def _spans_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


def extract_club_mentions(
    prompt: str | None,
    team_names: list[str] | None = None,
) -> dict[str, Any]:
    """
    Resolve specific club mentions longest-match-first by character span, ordered by
    appearance, and report standalone ambiguous terms ('United', 'City') separately.
    """
    active_teams = list(team_names) if team_names else list(CANONICAL_TEAMS)
    active_set = set(active_teams)

    if not prompt:
        return {"matched_teams": [], "ambiguous_term": None, "ambiguous_candidates": []}

    low = prompt.lower()

    phrase_map: dict[str, str] = {}
    for alias, canon in SPECIFIC_CLUB_ALIASES.items():
        if canon in active_set:
            phrase_map[alias] = canon
    for t in active_teams:
        t_low = t.lower()
        if t_low not in ("united", "city"):
            phrase_map.setdefault(t_low, t)

    # Sort longest-first so full names like "Newcastle United" claim their span before short aliases.
    sorted_phrases = sorted(phrase_map.items(), key=lambda kv: (-len(kv[0]), kv[0]))

    claimed_spans: list[tuple[int, int]] = []
    span_hits: list[tuple[int, str]] = []
    for phrase, canon in sorted_phrases:
        pattern = rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])"
        for m in re.finditer(pattern, low):
            span = (m.start(), m.end())
            if not any(_spans_overlap(span, c) for c in claimed_spans):
                claimed_spans.append(span)
                span_hits.append((m.start(), canon))

    span_hits.sort(key=lambda item: item[0])
    matched_teams: list[str] = []
    for _, canon in span_hits:
        if canon not in matched_teams:
            matched_teams.append(canon)

    ambiguous_term: str | None = None
    ambiguous_candidates: list[str] = []
    for token, display_tok in (("united", "United"), ("city", "City")):
        tok_pat = rf"(?<![a-z0-9]){token}(?![a-z0-9])"
        has_unclaimed = any(
            not any(_spans_overlap((m.start(), m.end()), c) for c in claimed_spans)
            for m in re.finditer(tok_pat, low)
        )
        if has_unclaimed:
            cands = [t for t in active_teams if token in t.lower()]
            if len(cands) > 1 or (len(cands) == 1 and not matched_teams):
                ambiguous_term = display_tok
                ambiguous_candidates = cands
                break

    return {
        "matched_teams": matched_teams,
        "ambiguous_term": ambiguous_term,
        "ambiguous_candidates": ambiguous_candidates,
    }


def _find_mentioned_team(prompt: str | None, team_names: list[str]) -> str | None:
    resolved = extract_club_mentions(prompt, team_names)
    matched = resolved["matched_teams"]
    return matched[0] if matched else None


def _conclusion_managerial_impact(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    team = str(cfg.get("team_name", "The club"))
    season = str(cfg.get("season_name", ""))
    charts = result.get("charts", {})
    timeline = charts.get("timeline", [])
    milestones = charts.get("milestones", [])
    window = int(charts.get("rolling_window", cfg.get("rolling_window", 4)))
    rows = result.get("table_rows", [])

    if len(rows) < 2:
        return f"Insufficient match data to evaluate {team} in {season}: 0 matches were found for this club and season."

    before, after = rows[0], rows[1]
    before_matches = int(before.get("matches", 0))
    after_matches = int(after.get("matches", 0))
    split_mw = int(milestones[0]["match_week"]) if milestones else int(cfg.get("milestone_match_week", 10))

    if before_matches <= 0 and after_matches <= 0:
        return f"Insufficient match data to evaluate {team} in {season}: 0 matches were found for this club and season."
    if before_matches <= 0:
        return (
            f"Insufficient pre-split sample to compare {team} in {season} around Matchweek {split_mw}: "
            f"0 matches were recorded before MW {split_mw} ({after_matches} matches from MW {split_mw} onward)."
        )
    if after_matches <= 0:
        return (
            f"Insufficient post-split sample to compare {team} in {season} around Matchweek {split_mw}: "
            f"0 matches were recorded from MW {split_mw} onward ({before_matches} matches before MW {split_mw})."
        )

    prev_mgr = milestones[0].get("previous_manager") if milestones else None
    new_mgr = milestones[0].get("new_manager") if milestones else None

    if prev_mgr and new_mgr and prev_mgr != new_mgr:
        shift_desc = f"since {new_mgr} replaced {prev_mgr} at Matchweek {split_mw}"
    elif new_mgr:
        shift_desc = f"since the Matchweek {split_mw} shift under {new_mgr}"
    else:
        shift_desc = f"since Matchweek {split_mw}"

    before_ppg = float(before["ppg"])
    after_ppg = float(after["ppg"])
    before_xgd = float(before["xg_diff_per90"])
    after_xgd = float(after["xg_diff_per90"])
    before_xgf = float(before["xgf_per90"])
    after_xgf = float(after["xgf_per90"])
    before_xga = float(before["xga_per90"])
    after_xga = float(after["xga_per90"])

    ppg_delta = round(after_ppg - before_ppg, 2)
    xgd_delta = round(after_xgd - before_xgd, 2)
    xgf_delta = round(after_xgf - before_xgf, 2)
    xga_delta = round(after_xga - before_xga, 2)

    xgd_dir = "up" if xgd_delta > 0.08 else ("down" if xgd_delta < -0.08 else "flat")
    ppg_dir = "up" if ppg_delta > 0.15 else ("down" if ppg_delta < -0.15 else "flat")

    verdict_map = {
        ("up", "up"): (
            f"Yes — {team} show an overall upward shift {shift_desc} ({season}), "
            "with both points output and underlying xG differential rising."
        ),
        ("up", "flat"): (
            f"Partially — {team}'s underlying xG differential has improved {shift_desc} ({season}), "
            "while points per game have stayed broadly flat."
        ),
        ("up", "down"): (
            f"Mixed — {team}'s underlying xG differential has improved {shift_desc} ({season}), "
            "even though points per game have declined."
        ),
        ("flat", "up"): (
            f"Partially — {team}'s points per game have risen {shift_desc} ({season}), "
            "while underlying xG differential has remained nearly flat."
        ),
        ("flat", "flat"): (
            f"{team}'s trajectory has held steady {shift_desc} ({season}), "
            "with minimal change in either points per game or underlying xG differential."
        ),
        ("flat", "down"): (
            f"Partially — {team}'s points per game have declined {shift_desc} ({season}), "
            "even though underlying xG differential has remained nearly flat."
        ),
        ("down", "up"): (
            f"Mixed — {team}'s points per game have risen {shift_desc} ({season}), "
            "but underlying xG differential has declined."
        ),
        ("down", "flat"): (
            f"No — {team}'s underlying xG differential has declined {shift_desc} ({season}), "
            "while points per game have held broadly steady."
        ),
        ("down", "down"): (
            f"No — {team} have declined {shift_desc} ({season}) "
            "in both points per game and underlying xG differential."
        ),
    }
    verdict = verdict_map[(xgd_dir, ppg_dir)]

    latest = timeline[-1] if timeline else None
    rolling_tail = (
        f", leaving their latest {window}-match rolling form at {latest['rolling_ppg']:.2f} PPG "
        f"({latest['rolling_xgf']:.2f} xGF vs {latest['rolling_xga']:.2f} xGA)"
        if latest
        else ""
    )

    xgf_dir = "up" if xgf_delta > 0.05 else ("down" if xgf_delta < -0.05 else "flat")
    xga_dir = "up" if xga_delta > 0.05 else ("down" if xga_delta < -0.05 else "flat")

    component_takeaways = {
        ("up", "down"): (
            f"both xG components moved favourably (attacking xGF rose {xgf_delta:+.2f}/match from "
            f"{before_xgf:.2f} to {after_xgf:.2f}, while xGA conceded fell {xga_delta:+.2f}/match from {before_xga:.2f} to {after_xga:.2f})."
        ),
        ("up", "flat"): (
            f"the xG differential rise came from attacking xGF increasing by {xgf_delta:+.2f}/match "
            f"({before_xgf:.2f} to {after_xgf:.2f}), while xGA conceded remained nearly flat ({before_xga:.2f} vs {after_xga:.2f}, {xga_delta:+.2f})."
        ),
        ("flat", "down"): (
            f"the xG differential improvement came from lower xGA conceded ({before_xga:.2f} to {after_xga:.2f}, {xga_delta:+.2f}/match) "
            f"rather than higher attacking xGF, which remained nearly flat ({before_xgf:.2f} vs {after_xgf:.2f}, {xgf_delta:+.2f})."
        ),
        ("up", "up"): (
            f"both attacking xGF ({before_xgf:.2f} to {after_xgf:.2f}, {xgf_delta:+.2f}/match) and xGA conceded "
            f"({before_xga:.2f} to {after_xga:.2f}, {xga_delta:+.2f}/match) increased across these fixtures."
        ),
        ("down", "down"): (
            f"both attacking xGF ({before_xgf:.2f} to {after_xgf:.2f}, {xgf_delta:+.2f}/match) and xGA conceded "
            f"({before_xga:.2f} to {after_xga:.2f}, {xga_delta:+.2f}/match) decreased across these fixtures."
        ),
        ("down", "flat"): (
            f"the lower xG differential stemmed from attacking xGF dropping by {xgf_delta:+.2f}/match "
            f"({before_xgf:.2f} to {after_xgf:.2f}) while xGA conceded stayed nearly flat ({before_xga:.2f} vs {after_xga:.2f}, {xga_delta:+.2f}), "
            "rather than higher xG conceded."
        ),
        ("flat", "up"): (
            f"the lower xG differential stemmed from xGA conceded rising by {xga_delta:+.2f}/match "
            f"({before_xga:.2f} to {after_xga:.2f}) while attacking xGF held nearly steady ({before_xgf:.2f} vs {after_xgf:.2f}, {xgf_delta:+.2f})."
        ),
        ("down", "up"): (
            f"both xG components moved unfavourably: attacking xGF fell by {xgf_delta:+.2f}/match "
            f"({before_xgf:.2f} to {after_xgf:.2f}) while xGA conceded rose by {xga_delta:+.2f}/match ({before_xga:.2f} to {after_xga:.2f})."
        ),
        ("flat", "flat"): (
            f"both underlying components stayed within a narrow band (xGF {before_xgf:.2f} → {after_xgf:.2f}, {xgf_delta:+.2f}; "
            f"xGA {before_xga:.2f} → {after_xga:.2f}, {xga_delta:+.2f})."
        ),
    }
    takeaway = component_takeaways[(xgf_dir, xga_dir)]

    limitation = ""
    if min(before_matches, after_matches) < 5 or (xgd_dir == "down" and ppg_dir == "up") or (xgd_dir == "up" and ppg_dir == "down"):
        limitation = (
            f" Note: this descriptive split (n={before_matches} vs n={after_matches}) does not adjust for opponent strength "
            "or match-state variance."
        )

    return (
        f"{verdict} Across {after_matches} matches from MW {split_mw} onward (vs {before_matches} before), "
        f"points per game moved from {before_ppg:.2f} to {after_ppg:.2f} ({ppg_delta:+.2f}), "
        f"with goals scored moving {before['gf_per90']:.2f} → {after['gf_per90']:.2f} and goals conceded "
        f"{before['ga_per90']:.2f} → {after['ga_per90']:.2f} per match. "
        f"Under the hood, xG differential shifted {before_xgd:+.2f} → {after_xgd:+.2f} per match ({xgd_delta:+.2f}; "
        f"xGF {before_xgf:.2f} → {after_xgf:.2f}, xGA {before_xga:.2f} → {after_xga:.2f})"
        f"{rolling_tail} — {takeaway}{limitation}"
    )


def _conclusion_tactical_intervention(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    team = str(cfg.get("team_name", "The team"))
    season = str(cfg.get("season_name", ""))
    charts = result.get("charts", {})
    mw = charts.get("match_window", {})
    start_mw = int(mw.get("start_mw", cfg.get("start_mw", 10)))
    end_mw = int(mw.get("end_mw", cfg.get("end_mw", 18)))
    matches = int(mw.get("matches", 0))
    season_matches = int(mw.get("season_matches", matches))
    radar = charts.get("radar", [])

    if season_matches <= 0:
        return (
            f"Insufficient data to assess {team} in {season}: 0 season matches were found for this club, "
            f"so MW {start_mw}–{end_mw} cannot be compared against a {season} baseline."
        )
    if matches <= 0 or not radar:
        return (
            f"Insufficient match sample to evaluate {team} during MW {start_mw}–{end_mw} in {season}: "
            f"0 matches were played in that window, so no tactical comparison against the {season} baseline can be made."
        )

    by_key = {item["key"]: item for item in radar if "key" in item}
    top_shift = max(radar, key=lambda r: abs(int(r["run_percentile"]) - int(r["season_percentile"])))
    top_pct_delta = int(top_shift["run_percentile"]) - int(top_shift["season_percentile"])
    max_abs_shift = abs(top_pct_delta)
    top_label = _clean_metric_label(str(top_shift["metric"])).lower()

    if max_abs_shift >= 15:
        verdict = (
            f"Yes — {team} showed a clear tactical shift during MW {start_mw}–{end_mw} ({matches} matches) "
            f"versus their {season} norm, led by a {top_pct_delta:+d}-percentile move in {top_label}."
        )
    elif max_abs_shift >= 7:
        verdict = (
            f"{team} showed moderate tactical shifts during MW {start_mw}–{end_mw} ({matches} matches) "
            f"rather than a complete overhaul, with the biggest swing in {top_label} ({top_pct_delta:+d} percentile pts)."
        )
    else:
        verdict = (
            f"Very little shifted structurally for {team} during MW {start_mw}–{end_mw} ({matches} matches); "
            f"nearly every indicator stayed close to their {season} baseline."
        )

    ppda = by_key.get("ppda", {})
    ht = by_key.get("high_turnovers_per90", {})
    poss = by_key.get("possession_share", {})
    direct = by_key.get("build_up_directness", {})
    prog = by_key.get("progressive_passes_per90", {})
    box = by_key.get("box_entries_per90", {})

    return (
        f"{verdict} Out of possession, pressing moved from {ppda.get('season_avg', 0):.2f} to {ppda.get('intervention_run', 0):.2f} PPDA "
        f"({_ordinal(int(ppda.get('run_percentile', 50)))} league percentile) alongside {ht.get('intervention_run', 0):.2f} high turnovers/90 "
        f"(vs {ht.get('season_avg', 0):.2f} season avg). With the ball, possession shifted {poss.get('season_avg', 0):.1f}% → "
        f"{poss.get('intervention_run', 0):.1f}% and long build-up share {direct.get('season_avg', 0):.1f}% → "
        f"{direct.get('intervention_run', 0):.1f}%, translating into {prog.get('intervention_run', 0):.1f} progressive passes/90 "
        f"(vs {prog.get('season_avg', 0):.1f}) and {box.get('intervention_run', 0):.1f} box entries/90 (vs {box.get('season_avg', 0):.1f})."
    )


def _conclusion_opposition_scouting(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    opp = str(cfg.get("opponent_name", "The opponent"))
    season = str(cfg.get("season_name", ""))
    charts = result.get("charts", {})
    kpis = charts.get("style_kpis", {})
    formations = charts.get("formations", [])
    threats = charts.get("danger_players", [])
    zones = result.get("pitch", {}).get("zones", [])

    matches_played = int(kpis.get("matches_played", 0))
    if matches_played <= 0:
        return (
            f"Insufficient data to scout {opp} in {season}: "
            "0 matches or events were found for this club in the connected dataset."
        )

    ppda = float(kpis["ppda"])
    poss = float(kpis["possession_share"])
    direct = float(kpis["build_up_directness"])
    xg90 = float(kpis["xg_per90"])

    raw_shape = formations[0].get("formation") if formations else None
    has_shape = raw_shape is not None and str(raw_shape).strip() not in ("", "None")
    shape_clause = f"built around a {raw_shape} base " if has_shape else "with no recorded starting formation "

    press_style = "high-pressing" if ppda < 9.5 else ("selective mid-press" if ppda <= 12.5 else "compact mid-to-low block")
    ball_style = "possession-dominant" if poss >= 54.0 else ("balanced" if poss >= 47.0 else "transition-oriented")

    active_zones = [
        z for z in zones
        if str(z.get("value_label", "0")).strip() not in ("", "0")
    ]
    top_zone = max(active_zones, key=lambda z: float(z.get("intensity", 0))) if active_zones else None
    zone_clause = (
        f"Their defensive actions concentrate most in the {top_zone['zone_id']} ({top_zone['value_label']} triggers)"
        if top_zone
        else "No defensive-action trigger zones were recorded"
    )

    observed_rows = [
        r for r in result.get("table_rows", [])
        if int(r.get("events", 0)) > 0
    ]
    states = {str(r["match_state"]).lower(): r for r in observed_rows}
    win_state = states.get("winning")
    lose_state = states.get("losing")

    if (
        win_state
        and lose_state
        and win_state.get("avg_def_line_m") is not None
        and lose_state.get("avg_def_line_m") is not None
    ):
        win_x = float(win_state["avg_def_line_m"])
        lose_x = float(lose_state["avg_def_line_m"])
        win_dir = float(win_state["directness_pct"])
        lose_dir = float(lose_state["directness_pct"])
        diff_x = round(win_x - lose_x, 1)

        if diff_x >= 1.0:
            state_clause = (
                f", while their event-derived average defensive-action location sits higher when leading ({win_x:.1f}m, "
                f"{win_dir:.1f}% long-pass directness) than when chasing ({lose_x:.1f}m, {lose_dir:.1f}% directness)."
            )
        elif diff_x <= -1.0:
            state_clause = (
                f", while their event-derived average defensive-action location sits deeper when leading ({win_x:.1f}m, "
                f"{win_dir:.1f}% long-pass directness) than when chasing ({lose_x:.1f}m, {lose_dir:.1f}% directness)."
            )
        elif abs(diff_x) < 0.05:
            state_clause = (
                f", while their average defensive-action location is identical when leading and chasing ({win_x:.1f}m; "
                f"{win_dir:.1f}% long-pass directness leading vs {lose_dir:.1f}% chasing)."
            )
        else:
            state_clause = (
                f", while their average defensive-action location differs only slightly by game state "
                f"({win_x:.1f}m with {win_dir:.1f}% long-pass directness when leading vs "
                f"{lose_x:.1f}m with {lose_dir:.1f}% directness when chasing, below a 1.0m threshold)."
            )
    elif observed_rows:
        parts = []
        for r in observed_rows:
            loc = f"{float(r['avg_def_line_m']):.1f}m avg defensive-action x" if r.get("avg_def_line_m") is not None else "no defensive-action x recorded"
            parts.append(f"{str(r['match_state']).lower()} ({loc}, {float(r['directness_pct']):.1f}% directness)")
        state_clause = (
            f", with match-state events recorded only while {', '.join(parts)} "
            "(insufficient state coverage to compare leading versus chasing)."
        )
    else:
        state_clause = ", with no match-state breakdown recorded."

    if len(threats) >= 2:
        d1, d2 = threats[0], threats[1]
        threat_clause = (
            f" Containing {d1['player_name']} ({d1['position']}, {d1['total_xg']:.2f} xG, {d1['key_passes']} key passes, "
            f"{d1['prog_actions']} progressive actions) and {d2['player_name']} ({d2['total_xg']:.2f} xG, {d2['key_passes']} key passes) "
            "is the top pre-match priority."
        )
    elif threats:
        d1 = threats[0]
        threat_clause = (
            f" Containing {d1['player_name']} ({d1['position']}, {d1['total_xg']:.2f} xG, {d1['key_passes']} key passes) "
            "is the main defensive priority."
        )
    else:
        threat_clause = ""

    return (
        f"{opp} ({season}, {matches_played} matches) project as a {ball_style}, {press_style} opponent {shape_clause}"
        f"({ppda:.2f} PPDA, {poss:.1f}% possession, {direct:.1f}% long build-up share, generating {xg90:.2f} xG/90). "
        f"{zone_clause}{state_clause}{threat_clause}"
    )


def _conclusion_player_progression(
    result: dict[str, Any],
    prompt: str | None,
    focus_player: Any = _UNSET,
) -> str:
    cfg = result.get("assumptions", {})
    s1 = str(cfg.get("season_1", "2023/2024"))
    s2 = str(cfg.get("season_2", "2024/2025"))
    min_mins = int(cfg.get("min_minutes", 450))
    charts = result.get("charts", {})
    norm = str(charts.get("normalisation", cfg.get("normalisation", "per_90")))
    comp = str(charts.get("composite", cfg.get("skill_composite", "ball_progression"))).replace("_", " ")
    total_q = int(charts.get("total_qualifiers", 0))
    ranked = result.get("table_rows", [])

    if not ranked or total_q <= 0:
        return (
            f"Insufficient qualifying player sample between {s1} and {s2}: "
            f"0 players logged at least {min_mins} minutes in both seasons."
        )

    norm_label = "possession-adjusted (PAdj)" if norm == "possession_adjusted" else "per-90"
    p1 = ranked[0]
    p1_delta = float(p1["delta"])
    if p1_delta > 0:
        lead = (
            f"Across {total_q} qualifying players (>= {min_mins} minutes in both {s1} and {s2}, {norm_label}), "
            f"{p1['player_name']} ({p1['team_name']}, {p1['position']}) improved the most in {comp}, "
            f"rising {p1_delta:+.2f} points ({p1['pct_change']:+.1f}%) from {p1['season_1_score']:.2f} to {p1['season_2_score']:.2f}."
        )
    elif p1_delta == 0:
        lead = (
            f"Across {total_q} qualifying players (>= {min_mins} minutes in both {s1} and {s2}, {norm_label}), "
            f"no player recorded a positive gain in {comp}, with {p1['player_name']} ({p1['team_name']}, {p1['position']}) "
            f"holding steady at {p1['season_2_score']:.2f} ({p1_delta:+.2f})."
        )
    else:
        lead = (
            f"Across {total_q} qualifying players (>= {min_mins} minutes in both {s1} and {s2}, {norm_label}), "
            f"every qualifier declined in {comp}, with {p1['player_name']} ({p1['team_name']}, {p1['position']}) "
            f"posting the smallest drop at {p1_delta:+.2f} points ({p1['pct_change']:+.1f}%, from {p1['season_1_score']:.2f} to {p1['season_2_score']:.2f})."
        )

    runners = ""
    if len(ranked) >= 3:
        p2, p3 = ranked[1], ranked[2]
        runners = (
            f" Behind them, {p2['player_name']} ({p2['team_name']}, {p2['delta']:+.2f}: {p2['season_1_score']:.2f} → {p2['season_2_score']:.2f}) "
            f"and {p3['player_name']} ({p3['team_name']}, {p3['delta']:+.2f}) completed the top three."
        )
    elif len(ranked) == 2:
        p2 = ranked[1]
        runners = f" {p2['player_name']} ({p2['team_name']}) followed in second at {p2['delta']:+.2f}."

    named_note = ""
    target_hint: str | None = None
    if focus_player is not _UNSET:
        target_hint = str(focus_player).lower() if focus_player else None
    elif prompt:
        target_hint = prompt.lower()

    if target_hint:
        for idx, row in enumerate(ranked[1:], start=2):
            pname = str(row["player_name"])
            last = pname.split()[-1].lower()
            if (
                pname.lower() in target_hint
                or (focus_player is _UNSET and len(last) >= 4 and re.search(rf"(?<![a-z0-9]){re.escape(last)}(?![a-z0-9])", target_hint))
            ):
                named_note = (
                    f" For your named player, {pname} ({row['team_name']}) placed #{idx} "
                    f"with a {row['delta']:+.2f} change ({row['season_1_score']:.2f} → {row['season_2_score']:.2f})."
                )
                break

    return (
        f"{lead}{runners}{named_note} "
        f"Every ranked player met the {min_mins}-minute floor in both seasons."
    )


def _conclusion_tactical_fit(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    season = str(cfg.get("season_name", ""))
    charts = result.get("charts", {})
    player = str(charts.get("player_name", "The target player"))
    current_club = str(charts.get("current_club", "their current club"))
    target_club = str(charts.get("target_club", "the target club"))
    fit_score = int(charts.get("fit_score", 0))
    rows = result.get("table_rows", [])

    if charts.get("player_matched") is False:
        req_player = str(charts.get("requested_player") or cfg.get("player_name") or player)
        return (
            f"Insufficient data to evaluate tactical fit for {req_player} in {season}: "
            "player was not found in the squad catalog."
        )

    curr_matches = int(charts.get("current_club_matches", 1))
    targ_matches = int(charts.get("target_club_matches", 1))
    if curr_matches <= 0 or targ_matches <= 0 or not rows:
        return (
            f"Insufficient match data in {season} to evaluate tactical fit for {player} "
            f"({current_club}: {curr_matches} matches; {target_club}: {targ_matches} matches)."
        )

    if current_club == target_club:
        return (
            f"{player} already plays within {target_club}'s tactical profile ({fit_score}% baseline alignment across all 6 team style metrics in {season}), "
            "meaning current and target team environments match directly."
        )

    if fit_score >= 82:
        verdict = f"High style overlap — {player}'s current club ({current_club}) shares a {fit_score}% team-style overlap with {target_club}."
    elif fit_score >= 68:
        verdict = (
            f"Moderate style overlap — {player}'s current club ({current_club}) shares a {fit_score}% team-style overlap with {target_club}, "
            "with specific metric gaps to account for."
        )
    else:
        verdict = (
            f"Low style overlap — {player}'s current club ({current_club}) shares a {fit_score}% team-style overlap with {target_club}, "
            "indicating distinct team style demands."
        )

    best_dim = max(rows, key=lambda r: int(r["overlap_pct"]))
    worst_dim = min(rows, key=lambda r: int(r["overlap_pct"]))
    strong_count = sum(1 for r in rows if int(r["overlap_pct"]) >= 85)
    best_label = _clean_metric_label(str(best_dim["dimension"]))
    worst_label = _clean_metric_label(str(worst_dim["dimension"]))

    return (
        f"{verdict} Across the six club-style dimensions, {strong_count} of 6 show strong alignment — closest on "
        f"{best_label} ({best_dim['overlap_pct']}% overlap: {best_dim['player_team_val']} vs {best_dim['target_club_val']}). "
        f"The widest gap sits in {worst_label}, where {current_club} averages {worst_dim['player_team_val']} "
        f"compared with {target_club}'s {worst_dim['target_club_val']} ({worst_dim['overlap_pct']}% overlap, {worst_dim['status']})."
    )


def _conclusion_league_xpts(
    result: dict[str, Any],
    prompt: str | None,
    focus_team: Any = _UNSET,
) -> str:
    cfg = result.get("assumptions", {})
    season = str(cfg.get("season_name", ""))
    rows = result.get("table_rows", [])
    if not rows:
        return (
            f"Insufficient match data in {season} to evaluate league table position against expected points "
            "(0 matches found)."
        )

    overperformers = sorted([r for r in rows if float(r["pts_residual"]) >= 3.0], key=lambda r: r["pts_residual"], reverse=True)
    underperformers = sorted([r for r in rows if float(r["pts_residual"]) <= -3.0], key=lambda r: r["pts_residual"])
    overperf = max(rows, key=lambda r: r["pts_residual"])
    underperf = min(rows, key=lambda r: r["pts_residual"])
    actual_leader = rows[0]
    xpts_leader = min(rows, key=lambda r: int(r["xpts_rank"]))
    ask_under = bool(prompt and any(k in prompt.lower() for k in ("underperform", "unluck", "lower in the table", "deserve more")))

    row_team_names = [str(r["team_name"]) for r in rows]
    if focus_team is not _UNSET:
        resolved_focus = str(focus_team) if focus_team and str(focus_team) in row_team_names else None
    else:
        resolved_focus = _find_mentioned_team(prompt, row_team_names)

    focused_lead = ""
    if resolved_focus:
        match_row = next((r for r in rows if r["team_name"] == resolved_focus), None)
        if match_row:
            focused_lead = (
                f"In {season}, {resolved_focus} sit #{match_row['actual_rank']} in the actual table "
                f"({match_row['actual_pts']} pts across {match_row['mp']} matches) versus #{match_row['xpts_rank']} on simulated xPTS "
                f"({match_row['xpts']:.1f} xPTS, {match_row['pts_residual']:+.1f} pts, {match_row['status']}; "
                f"{match_row['xgf']:.2f} xGF vs {match_row['xga']:.2f} xGA, {match_row['xgd']:+.2f} xGD). "
            )

    scope_prefix = "League-wide," if focused_lead else f"In {season},"
    no_thresh_prefix = "League-wide, no club" if focused_lead else "No club"

    if ask_under:
        if underperformers:
            names = ", ".join(
                f"{r['team_name']} (#{r['actual_rank']} actual vs #{r['xpts_rank']} xPTS, {r['pts_residual']:+.1f} pts)"
                for r in underperformers[:3]
            )
            lead = f"{scope_prefix} the clubs most shortchanged relative to their underlying play are {names}."
        else:
            lead = (
                f"{no_thresh_prefix} fell below the -3.0 point underperformance threshold in {season}, though "
                f"{underperf['team_name']} had the steepest shortfall ({underperf['pts_residual']:+.1f} pts: "
                f"{underperf['actual_pts']} actual vs {underperf['xpts']:.1f} xPTS, #{underperf['actual_rank']} vs #{underperf['xpts_rank']})."
            )
        contrast = (
            f"Conversely, {overperf['team_name']} overperformed their shot quality the most "
            f"({overperf['actual_pts']} pts from {overperf['xpts']:.1f} xPTS, {overperf['pts_residual']:+.1f}, "
            f"#{overperf['actual_rank']} actual vs #{overperf['xpts_rank']} xPTS)"
        )
    else:
        if overperformers:
            names = ", ".join(
                f"{r['team_name']} (#{r['actual_rank']} actual vs #{r['xpts_rank']} xPTS, {r['pts_residual']:+.1f} pts)"
                for r in overperformers[:3]
            )
            lead = f"{scope_prefix} the clubs sitting noticeably higher than their underlying play suggested are {names}."
        else:
            lead = (
                f"{no_thresh_prefix} exceeded the +3.0 point overperformance threshold in {season}, though "
                f"{overperf['team_name']} posted the largest positive margin ({overperf['pts_residual']:+.1f} pts: "
                f"{overperf['actual_pts']} actual vs {overperf['xpts']:.1f} xPTS, #{overperf['actual_rank']} vs #{overperf['xpts_rank']})."
            )
        contrast = (
            f"Conversely, {underperf['team_name']} suffered the biggest shortfall against chance quality "
            f"({underperf['actual_pts']} pts from {underperf['xpts']:.1f} xPTS, {underperf['pts_residual']:+.1f}, "
            f"#{underperf['actual_rank']} actual vs #{underperf['xpts_rank']} xPTS)"
        )

    leader_note = (
        f"{xpts_leader['team_name']} led the league in underlying xPTS ({xpts_leader['xpts']:.1f} xPTS, {xpts_leader['xgd']:+.2f} xGD), "
        + (
            "matching their first-place finish."
            if xpts_leader["team_name"] == actual_leader["team_name"]
            else f"despite trailing actual leaders {actual_leader['team_name']} ({actual_leader['actual_pts']} pts)."
        )
    )

    return f"{focused_lead}{lead} {contrast}, while {leader_note}"


def _conclusion_shot_zones(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    team = str(cfg.get("team_name", "The team"))
    season = str(cfg.get("season_name", ""))
    rows = result.get("table_rows", [])
    total_shots = int(result.get("charts", {}).get("total_shots", 0))

    if not rows or total_shots <= 0:
        return (
            f"Insufficient shot data for {team} in {season}: "
            "0 shot events were recorded for this club and season."
        )

    vol_zone = max(rows, key=lambda r: int(r["team_shots"]))
    best_zone = max(rows, key=lambda r: (int(r["goals"]), float(r["total_xg"])))
    top_xg_zone = max(rows, key=lambda r: (float(r["total_xg"]), int(r["team_shots"])))
    central_names = {"Six-Yard Box", "Central Penalty Area", "Left Box Channel", "Right Box Channel"}
    central_rows = [r for r in rows if r["zone"] in central_names]
    outside_rows = [r for r in rows if r["zone"] not in central_names]

    central_share = round(sum(float(r["shot_share_pct"]) for r in central_rows), 1)
    lg_central_share = round(sum(float(r["league_share_pct"]) for r in central_rows), 1)
    outside_share = round(sum(float(r["shot_share_pct"]) for r in outside_rows), 1)
    outside_goals = sum(int(r["goals"]) for r in outside_rows)
    total_goals = sum(int(r["goals"]) for r in rows)
    total_xg = round(sum(float(r["total_xg"]) for r in rows), 2)
    finishing_delta = round(total_goals - total_xg, 2)
    overall_conv = round(100.0 * total_goals / max(1, total_shots), 1)

    if finishing_delta >= 2.0:
        finishing_verdict = f"above-expectation conversion ({finishing_delta:+.2f} goals above xG, {overall_conv:.1f}% overall conversion)"
    elif finishing_delta <= -2.0:
        finishing_verdict = f"below-expectation conversion ({finishing_delta:+.2f} goals vs xG, {overall_conv:.1f}% overall conversion)"
    else:
        finishing_verdict = f"goal conversion closely aligned with chance quality ({finishing_delta:+.2f} goals vs xG, {overall_conv:.1f}% conversion)"

    if total_goals == 0:
        goal_clause = (
            f"They recorded 0 goals across those {total_shots} shots, generating their highest xG total in the "
            f"{top_xg_zone['zone']} ({top_xg_zone['team_shots']} shots, {top_xg_zone['total_xg']:.2f} xG at {top_xg_zone['xg_per_shot']:.2f} xG/shot)."
        )
    else:
        goal_clause = (
            f"Their highest goal return came from the {best_zone['zone']} ({best_zone['goals']} goals at {best_zone['conversion_pct']:.1f}% conversion "
            f"vs {best_zone['league_conversion_pct']:.1f}% league avg), while outside-box and wide zones accounted for {outside_share:.1f}% of attempts ({outside_goals} goals)."
        )

    return (
        f"{team} took {total_shots} shots in {season}, directing {central_share:.1f}% of attempts inside the penalty box "
        f"(vs {lg_central_share:.1f}% league avg) and concentrating their highest volume in the {vol_zone['zone']} "
        f"({vol_zone['team_shots']} shots, {vol_zone['shot_share_pct']:.1f}% share at {vol_zone['xg_per_shot']:.2f} xG/shot). "
        f"{goal_clause} "
        f"Across all zones, scoring {total_goals} goals from {total_xg:.2f} total xG reflects {finishing_verdict}."
    )


def build_analysis_conclusion(
    result: dict[str, Any],
    prompt: str | None = None,
    verification: dict[str, Any] | None = None,
    focus_team: Any = _UNSET,
    focus_player: Any = _UNSET,
) -> str:
    """Ingest full module outputs (charts, pitch, tables, assumptions) into one succinct answer paragraph."""
    m_id = str(result.get("module_id", ""))

    if m_id == "managerial_impact_tracker":
        paragraph = _conclusion_managerial_impact(result)
    elif m_id == "tactical_intervention_comparison":
        paragraph = _conclusion_tactical_intervention(result)
    elif m_id == "opposition_scouting_one_pager":
        paragraph = _conclusion_opposition_scouting(result)
    elif m_id == "multi_season_player_progression":
        paragraph = _conclusion_player_progression(result, prompt, focus_player=focus_player)
    elif m_id == "tactical_fit_recruitment_matcher":
        paragraph = _conclusion_tactical_fit(result)
    elif m_id == "league_table_vs_underlying_play":
        paragraph = _conclusion_league_xpts(result, prompt, focus_team=focus_team)
    elif m_id == "shot_location_zone_efficiency":
        paragraph = _conclusion_shot_zones(result)
    else:
        paragraph = str(result.get("summary", ""))

    if verification and not verification.get("all_passed", True):
        passed = verification.get("checks_passed", 0)
        total = verification.get("checks_total", 0)
        paragraph = f"{paragraph} (Verification warning: only {passed}/{total} automated verification checks passed; review flagged checks before acting.)"

    return paragraph
