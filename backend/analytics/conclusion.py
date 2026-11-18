"""Synthesize a concise, data-grounded football conclusion paragraph from analytical outputs."""

from __future__ import annotations

import re
from typing import Any


def _clean_metric_label(label: str) -> str:
    return re.sub(r"\s*\((?:%|Lower PPDA)\)", "", label).strip()


def _ordinal(n: int) -> str:
    n_abs = abs(int(n))
    if 11 <= (n_abs % 100) <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n_abs % 10, "th")
    return f"{int(n)}{suffix}"


def _find_mentioned_team(prompt: str | None, team_names: list[str]) -> str | None:
    if not prompt:
        return None
    low = prompt.lower()
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
    }
    for alias, canon in aliases.items():
        if re.search(rf"\b{re.escape(alias)}\b", low) and canon in team_names:
            return canon
    for t in team_names:
        if t.lower() in low:
            return t
    return None


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
        return result.get("summary", f"Insufficient match timeline data for {team} in {season}.")

    before, after = rows[0], rows[1]
    split_mw = int(milestones[0]["match_week"]) if milestones else int(cfg.get("milestone_match_week", 10))
    prev_mgr = milestones[0].get("previous_manager") if milestones else None
    new_mgr = milestones[0].get("new_manager") if milestones else None

    if prev_mgr and new_mgr and prev_mgr != new_mgr:
        shift_desc = f"since {new_mgr} replaced {prev_mgr} at Matchweek {split_mw}"
    elif new_mgr:
        shift_desc = f"since the Matchweek {split_mw} shift under {new_mgr}"
    else:
        shift_desc = f"since Matchweek {split_mw}"

    ppg_delta = after["ppg"] - before["ppg"]
    xgd_delta = after["xg_diff_per90"] - before["xg_diff_per90"]

    if xgd_delta > 0.08 and ppg_delta > 0.15:
        verdict = f"Yes — {team} are genuinely trending in the right direction {shift_desc} ({season})."
    elif xgd_delta > 0.08 and ppg_delta <= 0.0:
        verdict = (
            f"{team}'s underlying play is improving {shift_desc} ({season}), "
            "even though the points return has yet to catch up."
        )
    elif xgd_delta <= 0.05 and ppg_delta > 0.15:
        verdict = (
            f"Partially — {team}'s results have picked up {shift_desc} ({season}), "
            "but underlying chance quality remains nearly flat."
        )
    elif xgd_delta < -0.08 and ppg_delta < -0.15:
        verdict = f"No — {team} have regressed in both points and underlying chance quality {shift_desc} ({season})."
    elif xgd_delta < -0.08:
        verdict = f"{team}'s underlying chance balance has dipped {shift_desc} ({season}), signaling fragile momentum."
    else:
        verdict = f"{team}'s trajectory has largely held steady {shift_desc} ({season}) without a decisive tactical breakout."

    latest = timeline[-1] if timeline else None
    rolling_tail = (
        f", leaving their latest {window}-match rolling form at {latest['rolling_ppg']:.2f} PPG "
        f"({latest['rolling_xgf']:.2f} xGF vs {latest['rolling_xga']:.2f} xGA)"
        if latest
        else ""
    )

    if ppg_delta > 0.1 and xgd_delta <= 0.05:
        takeaway = "meaning the recent points lift owes more to sharper finishing and box survival than sustained territorial dominance."
    elif xgd_delta > 0.08:
        takeaway = "confirming tangible progress in both chance creation and match control."
    elif xgd_delta < -0.08:
        takeaway = "indicating that opponents are generating higher-value looks than before."
    else:
        takeaway = "pointing to marginal rather than structural change so far."

    return (
        f"{verdict} Across {after['matches']} matches from MW {split_mw} onward (vs {before['matches']} before), "
        f"points per game shifted from {before['ppg']:.2f} to {after['ppg']:.2f} ({ppg_delta:+.2f}), "
        f"with scoring moving {before['gf_per90']:.2f} → {after['gf_per90']:.2f} and conceding "
        f"{before['ga_per90']:.2f} → {after['ga_per90']:.2f} goals per match. "
        f"Under the hood, xG differential changed {before['xg_diff_per90']:+.2f} → {after['xg_diff_per90']:+.2f} per match "
        f"(xGF {before['xgf_per90']:.2f} → {after['xgf_per90']:.2f}, xGA {before['xga_per90']:.2f} → {after['xga_per90']:.2f})"
        f"{rolling_tail} — {takeaway}"
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
    radar = charts.get("radar", [])

    if not radar:
        return result.get("summary", f"No tactical intervention data found for {team}.")

    by_key = {item["key"]: item for item in radar if "key" in item}
    top_shift = max(radar, key=lambda r: abs(int(r["run_percentile"]) - int(r["season_percentile"])))
    top_pct_delta = int(top_shift["run_percentile"]) - int(top_shift["season_percentile"])
    max_abs_shift = abs(top_pct_delta)
    top_label = _clean_metric_label(str(top_shift["metric"])).lower()

    if max_abs_shift >= 15:
        verdict = (
            f"Yes — {team} made a clear tactical adjustment during MW {start_mw}–{end_mw} ({matches} matches) "
            f"versus their {season} norm, led by a {top_pct_delta:+d}-percentile shift in {top_label}."
        )
    elif max_abs_shift >= 7:
        verdict = (
            f"{team} showed moderate tactical tweaks during MW {start_mw}–{end_mw} ({matches} matches) "
            f"rather than a complete overhaul, with the biggest swing in {top_label} ({top_pct_delta:+d} percentile pts)."
        )
    else:
        verdict = (
            f"Very little changed structurally for {team} during MW {start_mw}–{end_mw} ({matches} matches); "
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
    states = {str(r["match_state"]).lower(): r for r in result.get("table_rows", [])}

    ppda = float(kpis.get("ppda", 12.0))
    poss = float(kpis.get("possession_share", 50.0))
    direct = float(kpis.get("build_up_directness", 20.0))
    xg90 = float(kpis.get("xg_per90", 1.2))
    shape = formations[0]["formation"] if formations else "4-3-3"

    press_style = "high-pressing" if ppda < 9.5 else ("selective mid-press" if ppda <= 12.5 else "compact mid-to-low block")
    ball_style = "possession-dominant" if poss >= 54.0 else ("balanced" if poss >= 47.0 else "transition-oriented")

    top_zone = max(zones, key=lambda z: float(z.get("intensity", 0))) if zones else None
    zone_clause = (
        f"Their defensive pressure concentrates in the {top_zone['zone_id']} ({top_zone['value_label']} triggers)"
        if top_zone
        else "Their defensive triggers span evenly across midfield lanes"
    )

    win_state = states.get("winning")
    lose_state = states.get("losing")
    if win_state and lose_state:
        state_clause = (
            f", while match state visibly shifts their block — dropping to a {win_state['avg_def_line_m']:.1f}m average line "
            f"({win_state['directness_pct']:.1f}% directness) when leading versus pushing up to {lose_state['avg_def_line_m']:.1f}m "
            f"({lose_state['directness_pct']:.1f}% directness) when chasing."
        )
    else:
        state_clause = "."

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
        f"{opp} ({season}) project as a {ball_style}, {press_style} opponent built around a {shape} base "
        f"({ppda:.2f} PPDA, {poss:.1f}% possession, {direct:.1f}% long build-up share, generating {xg90:.2f} xG/90). "
        f"{zone_clause}{state_clause}{threat_clause}"
    )


def _conclusion_player_progression(result: dict[str, Any], prompt: str | None) -> str:
    cfg = result.get("assumptions", {})
    s1 = str(cfg.get("season_1", "2023/2024"))
    s2 = str(cfg.get("season_2", "2024/2025"))
    min_mins = int(cfg.get("min_minutes", 450))
    charts = result.get("charts", {})
    norm = str(charts.get("normalisation", cfg.get("normalisation", "per_90")))
    comp = str(charts.get("composite", cfg.get("skill_composite", "ball_progression"))).replace("_", " ")
    total_q = int(charts.get("total_qualifiers", 0))
    ranked = result.get("table_rows", [])

    if not ranked:
        return (
            f"No players logged at least {min_mins} minutes in both {s1} and {s2}; "
            "lowering the minimum minutes threshold will reveal qualifying cross-season improvers."
        )

    norm_label = "possession-adjusted (PAdj)" if norm == "possession_adjusted" else "per-90"
    p1 = ranked[0]
    lead = (
        f"Across {total_q} qualifying players (>= {min_mins} minutes in both {s1} and {s2}, {norm_label}), "
        f"{p1['player_name']} ({p1['team_name']}, {p1['position']}) improved the most in {comp}, "
        f"jumping {p1['delta']:+.2f} points ({p1['pct_change']:+.1f}%) from {p1['season_1_score']:.2f} to {p1['season_2_score']:.2f}."
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
    if prompt:
        low = prompt.lower()
        for idx, row in enumerate(ranked[1:], start=2):
            pname = str(row["player_name"])
            last = pname.split()[-1].lower()
            if pname.lower() in low or (len(last) >= 4 and re.search(rf"\b{re.escape(last)}\b", low)):
                named_note = (
                    f" For your named player, {pname} ({row['team_name']}) placed #{idx} "
                    f"with a {row['delta']:+.2f} change ({row['season_1_score']:.2f} → {row['season_2_score']:.2f})."
                )
                break

    return (
        f"{lead}{runners}{named_note} "
        "Because every ranked player cleared the two-season minute floor, these deltas reflect sustained role output rather than cameo variance."
    )


def _conclusion_tactical_fit(result: dict[str, Any]) -> str:
    charts = result.get("charts", {})
    player = str(charts.get("player_name", "The target player"))
    current_club = str(charts.get("current_club", "their current club"))
    target_club = str(charts.get("target_club", "the target club"))
    fit_score = int(charts.get("fit_score", 0))
    rows = result.get("table_rows", [])

    if current_club == target_club:
        return (
            f"{player} already plays within {target_club}'s tactical structure ({fit_score}% baseline alignment across all 6 style metrics), "
            "so no cross-system transition risk exists."
        )

    if fit_score >= 82:
        verdict = f"Yes — {player} profiles as a strong tactical fit for {target_club}, posting an {fit_score}% style overlap from {current_club}."
    elif fit_score >= 68:
        verdict = (
            f"Conditionally yes — {player} projects as a solid {fit_score}% tactical fit for {target_club}, "
            "though specific tactical adjustments would be needed."
        )
    else:
        verdict = (
            f"Proceed with caution — {player} records a {fit_score}% tactical fit score moving from {current_club} to {target_club}, "
            "indicating a demanding stylistic transition."
        )

    if not rows:
        return verdict

    best_dim = max(rows, key=lambda r: int(r["overlap_pct"]))
    worst_dim = min(rows, key=lambda r: int(r["overlap_pct"]))
    strong_count = sum(1 for r in rows if int(r["overlap_pct"]) >= 85)
    best_label = _clean_metric_label(str(best_dim["dimension"]))
    worst_label = _clean_metric_label(str(worst_dim["dimension"]))

    return (
        f"{verdict} Across the six club-style dimensions, {strong_count} of 6 show strong alignment — led by "
        f"{best_label} ({best_dim['overlap_pct']}% overlap: {best_dim['player_team_val']} vs {best_dim['target_club_val']}). "
        f"The main adaptation gap sits in {worst_label}, where {current_club} averages {worst_dim['player_team_val']} "
        f"compared with {target_club}'s {worst_dim['target_club_val']} ({worst_dim['overlap_pct']}% overlap, {worst_dim['status']}), "
        "making that the primary coaching adjustment if signed."
    )


def _conclusion_league_xpts(result: dict[str, Any], prompt: str | None) -> str:
    cfg = result.get("assumptions", {})
    season = str(cfg.get("season_name", ""))
    rows = result.get("table_rows", [])
    if not rows:
        return "No match data found to evaluate table position against expected points."

    overperformers = sorted([r for r in rows if float(r["pts_residual"]) >= 3.0], key=lambda r: r["pts_residual"], reverse=True)
    underperformers = sorted([r for r in rows if float(r["pts_residual"]) <= -3.0], key=lambda r: r["pts_residual"])
    overperf = max(rows, key=lambda r: r["pts_residual"])
    underperf = min(rows, key=lambda r: r["pts_residual"])
    actual_leader = rows[0]
    xpts_leader = min(rows, key=lambda r: int(r["xpts_rank"]))
    ask_under = bool(prompt and any(k in prompt.lower() for k in ("underperform", "unluck", "lower in the table", "deserve more")))

    if ask_under:
        if underperformers:
            names = ", ".join(
                f"{r['team_name']} (#{r['actual_rank']} actual vs #{r['xpts_rank']} xPTS, {r['pts_residual']:+.1f} pts)"
                for r in underperformers[:3]
            )
            lead = f"In {season}, the clubs most shortchanged relative to their underlying play are {names}."
        else:
            lead = (
                f"No club fell below the -3.0 point underperformance threshold in {season}, though "
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
            lead = f"In {season}, the clubs sitting noticeably higher than their underlying play deserved are {names}."
        else:
            lead = (
                f"No club exceeded the +3.0 point overperformance threshold in {season}, though "
                f"{overperf['team_name']} posted the largest positive margin ({overperf['pts_residual']:+.1f} pts: "
                f"{overperf['actual_pts']} actual vs {overperf['xpts']:.1f} xPTS, #{overperf['actual_rank']} vs #{overperf['xpts_rank']})."
            )
        contrast = (
            f"Conversely, {underperf['team_name']} suffered the biggest shortfall against chance quality "
            f"({underperf['actual_pts']} pts from {underperf['xpts']:.1f} xPTS, {underperf['pts_residual']:+.1f}, "
            f"#{underperf['actual_rank']} actual vs #{underperf['xpts_rank']} xPTS)"
        )

    leader_note = (
        f"{xpts_leader['team_name']} led the league in underlying performance ({xpts_leader['xpts']:.1f} xPTS, {xpts_leader['xgd']:+.2f} xGD), "
        + (
            "matching their first-place finish."
            if xpts_leader["team_name"] == actual_leader["team_name"]
            else f"despite trailing actual leaders {actual_leader['team_name']} ({actual_leader['actual_pts']} pts)."
        )
    )

    focused_team = _find_mentioned_team(prompt, [str(r["team_name"]) for r in rows])
    focus_note = ""
    if focused_team and focused_team not in {overperf["team_name"], underperf["team_name"]}:
        match_row = next((r for r in rows if r["team_name"] == focused_team), None)
        if match_row:
            focus_note = (
                f" Specifically, {focused_team} sit #{match_row['actual_rank']} ({match_row['actual_pts']} pts) "
                f"versus #{match_row['xpts_rank']} on xPTS ({match_row['xpts']:.1f}, {match_row['pts_residual']:+.1f}, {match_row['status']})."
            )

    return f"{lead} {contrast}, while {leader_note}{focus_note}"


def _conclusion_shot_zones(result: dict[str, Any]) -> str:
    cfg = result.get("assumptions", {})
    team = str(cfg.get("team_name", "The team"))
    season = str(cfg.get("season_name", ""))
    rows = result.get("table_rows", [])
    total_shots = int(result.get("charts", {}).get("total_shots", 0))

    if not rows or total_shots == 0:
        return f"No shot events were recorded for {team} in {season}."

    vol_zone = max(rows, key=lambda r: int(r["team_shots"]))
    best_zone = max(rows, key=lambda r: (int(r["goals"]), float(r["total_xg"])))
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
        finishing_verdict = f"clinical finishing ({finishing_delta:+.2f} goals above expected, {overall_conv:.1f}% overall conversion)"
    elif finishing_delta <= -2.0:
        finishing_verdict = f"below-expectation finishing ({finishing_delta:+.2f} goals vs xG, {overall_conv:.1f}% overall conversion)"
    else:
        finishing_verdict = f"finishing closely aligned with chance quality ({finishing_delta:+.2f} goals vs xG, {overall_conv:.1f}% conversion)"

    return (
        f"{team} took {total_shots} shots in {season}, directing {central_share:.1f}% of attempts inside the penalty box "
        f"(vs {lg_central_share:.1f}% league avg) and concentrating their highest volume in the {vol_zone['zone']} "
        f"({vol_zone['team_shots']} shots, {vol_zone['shot_share_pct']:.1f}% share at {vol_zone['xg_per_shot']:.2f} xG/shot). "
        f"Their richest goal return came from the {best_zone['zone']} ({best_zone['goals']} goals at {best_zone['conversion_pct']:.1f}% conversion "
        f"vs {best_zone['league_conversion_pct']:.1f}% league avg), while outside-box and wide zones accounted for {outside_share:.1f}% of attempts ({outside_goals} goals). "
        f"Across all zones, scoring {total_goals} goals from {total_xg:.2f} total xG reflects {finishing_verdict}."
    )


def build_analysis_conclusion(
    result: dict[str, Any],
    prompt: str | None = None,
    verification: dict[str, Any] | None = None,
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
        paragraph = _conclusion_player_progression(result, prompt)
    elif m_id == "tactical_fit_recruitment_matcher":
        paragraph = _conclusion_tactical_fit(result)
    elif m_id == "league_table_vs_underlying_play":
        paragraph = _conclusion_league_xpts(result, prompt)
    elif m_id == "shot_location_zone_efficiency":
        paragraph = _conclusion_shot_zones(result)
    else:
        paragraph = str(result.get("summary", ""))

    if verification and not verification.get("all_passed", True):
        passed = verification.get("checks_passed", 0)
        total = verification.get("checks_total", 0)
        paragraph = f"{paragraph} (Note: {passed}/{total} automated verification checks passed; review flagged checks before acting.)"

    return paragraph
