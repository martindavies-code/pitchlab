import type { ModuleResultPayload, VerificationReport } from "./types";

function fmtSigned(val: number, decimals: number): string {
  const clean = Object.is(val, -0) ? 0 : val;
  const sign = clean < 0 ? "-" : "+";
  return `${sign}${Math.abs(clean).toFixed(decimals)}`;
}

function fmtSignedInt(val: number): string {
  const n = Math.trunc(val);
  return n < 0 ? `${n}` : `+${n}`;
}

function fmtFixed(val: number, decimals: number): string {
  const clean = Object.is(val, -0) ? 0 : val;
  return clean.toFixed(decimals);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanMetricLabel(label: string): string {
  return label.replace(/\s*\((?:%|Lower PPDA)\)/g, "").trim();
}

function ordinal(n: number): string {
  const num = Math.trunc(n);
  const absN = Math.abs(num);
  if (absN % 100 >= 11 && absN % 100 <= 13) return `${num}th`;
  const mod = absN % 10;
  const suffix = mod === 1 ? "st" : mod === 2 ? "nd" : mod === 3 ? "rd" : "th";
  return `${num}${suffix}`;
}

function findMentionedTeam(prompt: string | null | undefined, teamNames: string[]): string | null {
  if (!prompt) return null;
  const low = prompt.toLowerCase();
  const aliases: Record<string, string> = {
    "man united": "Manchester United",
    "man utd": "Manchester United",
    united: "Manchester United",
    "man city": "Manchester City",
    city: "Manchester City",
    spurs: "Tottenham Hotspur",
    tottenham: "Tottenham Hotspur",
    villa: "Aston Villa",
    newcastle: "Newcastle United",
    brighton: "Brighton & Hove Albion",
    "west ham": "West Ham United",
  };
  for (const [alias, canon] of Object.entries(aliases)) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
    if (re.test(low) && teamNames.includes(canon)) {
      return canon;
    }
  }
  for (const t of teamNames) {
    if (low.includes(t.toLowerCase())) {
      return t;
    }
  }
  return null;
}

function conclusionManagerialImpact(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const team = String(cfg.team_name || "The club");
  const season = String(cfg.season_name || "");
  const charts = result.charts || {};
  const timeline = (charts.timeline as Array<Record<string, any>>) || [];
  const milestones = (charts.milestones as Array<Record<string, any>>) || [];
  const window = Number(charts.rolling_window ?? cfg.rolling_window ?? 4);
  const rows = result.table_rows || [];

  if (rows.length < 2) {
    return result.summary || `Insufficient match timeline data for ${team} in ${season}.`;
  }

  const before = rows[0];
  const after = rows[1];
  const splitMw = milestones.length ? Number(milestones[0].match_week) : Number(cfg.milestone_match_week ?? 10);
  const prevMgr = milestones.length ? milestones[0].previous_manager : null;
  const newMgr = milestones.length ? milestones[0].new_manager : null;

  let shiftDesc = `since Matchweek ${splitMw}`;
  if (prevMgr && newMgr && prevMgr !== newMgr) {
    shiftDesc = `since ${newMgr} replaced ${prevMgr} at Matchweek ${splitMw}`;
  } else if (newMgr) {
    shiftDesc = `since the Matchweek ${splitMw} shift under ${newMgr}`;
  }

  const ppgDelta = Number(after.ppg) - Number(before.ppg);
  const xgdDelta = Number(after.xg_diff_per90) - Number(before.xg_diff_per90);

  let verdict: string;
  if (xgdDelta > 0.08 && ppgDelta > 0.15) {
    verdict = `Yes — ${team} are genuinely trending in the right direction ${shiftDesc} (${season}).`;
  } else if (xgdDelta > 0.08 && ppgDelta <= 0.0) {
    verdict = `${team}'s underlying play is improving ${shiftDesc} (${season}), even though the points return has yet to catch up.`;
  } else if (xgdDelta <= 0.05 && ppgDelta > 0.15) {
    verdict = `Partially — ${team}'s results have picked up ${shiftDesc} (${season}), but underlying chance quality remains nearly flat.`;
  } else if (xgdDelta < -0.08 && ppgDelta < -0.15) {
    verdict = `No — ${team} have regressed in both points and underlying chance quality ${shiftDesc} (${season}).`;
  } else if (xgdDelta < -0.08) {
    verdict = `${team}'s underlying chance balance has dipped ${shiftDesc} (${season}), signaling fragile momentum.`;
  } else {
    verdict = `${team}'s trajectory has largely held steady ${shiftDesc} (${season}) without a decisive tactical breakout.`;
  }

  const latest = timeline.length ? timeline[timeline.length - 1] : null;
  const rollingTail = latest
    ? `, leaving their latest ${window}-match rolling form at ${fmtFixed(Number(latest.rolling_ppg), 2)} PPG (${fmtFixed(Number(latest.rolling_xgf), 2)} xGF vs ${fmtFixed(Number(latest.rolling_xga), 2)} xGA)`
    : "";

  let takeaway: string;
  if (ppgDelta > 0.1 && xgdDelta <= 0.05) {
    takeaway = "meaning the recent points lift owes more to sharper finishing and box survival than sustained territorial dominance.";
  } else if (xgdDelta > 0.08) {
    takeaway = "confirming tangible progress in both chance creation and match control.";
  } else if (xgdDelta < -0.08) {
    takeaway = "indicating that opponents are generating higher-value looks than before.";
  } else {
    takeaway = "pointing to marginal rather than structural change so far.";
  }

  return (
    `${verdict} Across ${after.matches} matches from MW ${splitMw} onward (vs ${before.matches} before), ` +
    `points per game shifted from ${fmtFixed(Number(before.ppg), 2)} to ${fmtFixed(Number(after.ppg), 2)} (${fmtSigned(ppgDelta, 2)}), ` +
    `with scoring moving ${fmtFixed(Number(before.gf_per90), 2)} → ${fmtFixed(Number(after.gf_per90), 2)} and conceding ` +
    `${fmtFixed(Number(before.ga_per90), 2)} → ${fmtFixed(Number(after.ga_per90), 2)} goals per match. ` +
    `Under the hood, xG differential changed ${fmtSigned(Number(before.xg_diff_per90), 2)} → ${fmtSigned(Number(after.xg_diff_per90), 2)} per match ` +
    `(xGF ${fmtFixed(Number(before.xgf_per90), 2)} → ${fmtFixed(Number(after.xgf_per90), 2)}, xGA ${fmtFixed(Number(before.xga_per90), 2)} → ${fmtFixed(Number(after.xga_per90), 2)})` +
    `${rollingTail} — ${takeaway}`
  );
}

function conclusionTacticalIntervention(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const team = String(cfg.team_name || "The team");
  const season = String(cfg.season_name || "");
  const charts = result.charts || {};
  const mw = (charts.match_window as Record<string, any>) || {};
  const startMw = Number(mw.start_mw ?? cfg.start_mw ?? 10);
  const endMw = Number(mw.end_mw ?? cfg.end_mw ?? 18);
  const matches = Number(mw.matches ?? 0);
  const radar = (charts.radar as Array<Record<string, any>>) || [];

  if (!radar.length) {
    return result.summary || `No tactical intervention data found for ${team}.`;
  }

  const byKey: Record<string, Record<string, any>> = {};
  let topShift = radar[0];
  for (const item of radar) {
    if (item.key) byKey[String(item.key)] = item;
    if (
      Math.abs(Number(item.run_percentile) - Number(item.season_percentile)) >
      Math.abs(Number(topShift.run_percentile) - Number(topShift.season_percentile))
    ) {
      topShift = item;
    }
  }

  const topPctDelta = Math.trunc(Number(topShift.run_percentile) - Number(topShift.season_percentile));
  const maxAbsShift = Math.abs(topPctDelta);
  const metricLower = cleanMetricLabel(String(topShift.metric || "")).toLowerCase();

  let verdict: string;
  if (maxAbsShift >= 15) {
    verdict =
      `Yes — ${team} made a clear tactical adjustment during MW ${startMw}–${endMw} (${matches} matches) ` +
      `versus their ${season} norm, led by a ${fmtSignedInt(topPctDelta)}-percentile shift in ${metricLower}.`;
  } else if (maxAbsShift >= 7) {
    verdict =
      `${team} showed moderate tactical tweaks during MW ${startMw}–${endMw} (${matches} matches) ` +
      `rather than a complete overhaul, with the biggest swing in ${metricLower} (${fmtSignedInt(topPctDelta)} percentile pts).`;
  } else {
    verdict =
      `Very little changed structurally for ${team} during MW ${startMw}–${endMw} (${matches} matches); ` +
      `nearly every indicator stayed close to their ${season} baseline.`;
  }

  const ppda = byKey.ppda || {};
  const ht = byKey.high_turnovers_per90 || {};
  const poss = byKey.possession_share || {};
  const direct = byKey.build_up_directness || {};
  const prog = byKey.progressive_passes_per90 || {};
  const box = byKey.box_entries_per90 || {};

  return (
    `${verdict} Out of possession, pressing moved from ${fmtFixed(Number(ppda.season_avg ?? 0), 2)} to ${fmtFixed(Number(ppda.intervention_run ?? 0), 2)} PPDA ` +
    `(${ordinal(Number(ppda.run_percentile ?? 50))} league percentile) alongside ${fmtFixed(Number(ht.intervention_run ?? 0), 2)} high turnovers/90 ` +
    `(vs ${fmtFixed(Number(ht.season_avg ?? 0), 2)} season avg). With the ball, possession shifted ${fmtFixed(Number(poss.season_avg ?? 0), 1)}% → ` +
    `${fmtFixed(Number(poss.intervention_run ?? 0), 1)}% and long build-up share ${fmtFixed(Number(direct.season_avg ?? 0), 1)}% → ` +
    `${fmtFixed(Number(direct.intervention_run ?? 0), 1)}%, translating into ${fmtFixed(Number(prog.intervention_run ?? 0), 1)} progressive passes/90 ` +
    `(vs ${fmtFixed(Number(prog.season_avg ?? 0), 1)}) and ${fmtFixed(Number(box.intervention_run ?? 0), 1)} box entries/90 (vs ${fmtFixed(Number(box.season_avg ?? 0), 1)}).`
  );
}

function conclusionOppositionScouting(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const opp = String(cfg.opponent_name || "The opponent");
  const season = String(cfg.season_name || "");
  const charts = result.charts || {};
  const kpis = (charts.style_kpis as Record<string, any>) || {};
  const formations = (charts.formations as Array<Record<string, any>>) || [];
  const threats = (charts.danger_players as Array<Record<string, any>>) || [];
  const zones = result.pitch?.zones || [];
  const states: Record<string, Record<string, any>> = {};
  for (const r of result.table_rows || []) {
    states[String(r.match_state).toLowerCase()] = r;
  }

  const ppda = Number(kpis.ppda ?? 12.0);
  const poss = Number(kpis.possession_share ?? 50.0);
  const direct = Number(kpis.build_up_directness ?? 20.0);
  const xg90 = Number(kpis.xg_per90 ?? 1.2);
  const shape = formations.length ? String(formations[0].formation) : "4-3-3";

  const pressStyle = ppda < 9.5 ? "high-pressing" : ppda <= 12.5 ? "selective mid-press" : "compact mid-to-low block";
  const ballStyle = poss >= 54.0 ? "possession-dominant" : poss >= 47.0 ? "balanced" : "transition-oriented";

  let topZone = zones[0] ?? null;
  for (const z of zones) {
    if (topZone && Number(z.intensity) > Number(topZone.intensity)) topZone = z;
  }
  const zoneClause = topZone
    ? `Their defensive pressure concentrates in the ${topZone.zone_id} (${topZone.value_label} triggers)`
    : "Their defensive triggers span evenly across midfield lanes";

  const winState = states.winning;
  const loseState = states.losing;
  const stateClause =
    winState && loseState
      ? `, while match state visibly shifts their block — dropping to a ${fmtFixed(Number(winState.avg_def_line_m), 1)}m average line ` +
        `(${fmtFixed(Number(winState.directness_pct), 1)}% directness) when leading versus pushing up to ${fmtFixed(Number(loseState.avg_def_line_m), 1)}m ` +
        `(${fmtFixed(Number(loseState.directness_pct), 1)}% directness) when chasing.`
      : ".";

  let threatClause = "";
  if (threats.length >= 2) {
    const [d1, d2] = threats;
    threatClause =
      ` Containing ${d1.player_name} (${d1.position}, ${fmtFixed(Number(d1.total_xg), 2)} xG, ${d1.key_passes} key passes, ` +
      `${d1.prog_actions} progressive actions) and ${d2.player_name} (${fmtFixed(Number(d2.total_xg), 2)} xG, ${d2.key_passes} key passes) ` +
      "is the top pre-match priority.";
  } else if (threats.length === 1) {
    const d1 = threats[0];
    threatClause =
      ` Containing ${d1.player_name} (${d1.position}, ${fmtFixed(Number(d1.total_xg), 2)} xG, ${d1.key_passes} key passes) ` +
      "is the main defensive priority.";
  }

  return (
    `${opp} (${season}) project as a ${ballStyle}, ${pressStyle} opponent built around a ${shape} base ` +
    `(${fmtFixed(ppda, 2)} PPDA, ${fmtFixed(poss, 1)}% possession, ${fmtFixed(direct, 1)}% long build-up share, generating ${fmtFixed(xg90, 2)} xG/90). ` +
    `${zoneClause}${stateClause}${threatClause}`
  );
}

function conclusionPlayerProgression(result: ModuleResultPayload, prompt?: string | null): string {
  const cfg = result.assumptions;
  const s1 = String(cfg.season_1 || "2023/2024");
  const s2 = String(cfg.season_2 || "2024/2025");
  const minMins = Number(cfg.min_minutes ?? 450);
  const charts = result.charts || {};
  const norm = String(charts.normalisation ?? cfg.normalisation ?? "per_90");
  const comp = String(charts.composite ?? cfg.skill_composite ?? "ball_progression").replace(/_/g, " ");
  const totalQ = Number(charts.total_qualifiers ?? 0);
  const ranked = result.table_rows || [];

  if (!ranked.length) {
    return (
      `No players logged at least ${minMins} minutes in both ${s1} and ${s2}; ` +
      "lowering the minimum minutes threshold will reveal qualifying cross-season improvers."
    );
  }

  const normLabel = norm === "possession_adjusted" ? "possession-adjusted (PAdj)" : "per-90";
  const p1 = ranked[0];
  const lead =
    `Across ${totalQ} qualifying players (>= ${minMins} minutes in both ${s1} and ${s2}, ${normLabel}), ` +
    `${p1.player_name} (${p1.team_name}, ${p1.position}) improved the most in ${comp}, ` +
    `jumping ${fmtSigned(Number(p1.delta), 2)} points (${fmtSigned(Number(p1.pct_change), 1)}%) ` +
    `from ${fmtFixed(Number(p1.season_1_score), 2)} to ${fmtFixed(Number(p1.season_2_score), 2)}.`;

  let runners = "";
  if (ranked.length >= 3) {
    const p2 = ranked[1];
    const p3 = ranked[2];
    runners =
      ` Behind them, ${p2.player_name} (${p2.team_name}, ${fmtSigned(Number(p2.delta), 2)}: ` +
      `${fmtFixed(Number(p2.season_1_score), 2)} → ${fmtFixed(Number(p2.season_2_score), 2)}) ` +
      `and ${p3.player_name} (${p3.team_name}, ${fmtSigned(Number(p3.delta), 2)}) completed the top three.`;
  } else if (ranked.length === 2) {
    const p2 = ranked[1];
    runners = ` ${p2.player_name} (${p2.team_name}) followed in second at ${fmtSigned(Number(p2.delta), 2)}.`;
  }

  let namedNote = "";
  if (prompt) {
    const low = prompt.toLowerCase();
    for (let i = 1; i < ranked.length; i++) {
      const row = ranked[i];
      const pname = String(row.player_name);
      const parts = pname.split(/\s+/);
      const last = parts[parts.length - 1].toLowerCase();
      const lastRe = new RegExp(`\\b${escapeRegex(last)}\\b`, "i");
      if (low.includes(pname.toLowerCase()) || (last.length >= 4 && lastRe.test(low))) {
        namedNote =
          ` For your named player, ${pname} (${row.team_name}) placed #${i + 1} ` +
          `with a ${fmtSigned(Number(row.delta), 2)} change (${fmtFixed(Number(row.season_1_score), 2)} → ${fmtFixed(Number(row.season_2_score), 2)}).`;
        break;
      }
    }
  }

  return (
    `${lead}${runners}${namedNote} ` +
    "Because every ranked player cleared the two-season minute floor, these deltas reflect sustained role output rather than cameo variance."
  );
}

function conclusionTacticalFit(result: ModuleResultPayload): string {
  const charts = result.charts || {};
  const player = String(charts.player_name || "The target player");
  const currentClub = String(charts.current_club || "their current club");
  const targetClub = String(charts.target_club || "the target club");
  const fitScore = Number(charts.fit_score ?? 0);
  const rows = result.table_rows || [];

  if (currentClub === targetClub) {
    return (
      `${player} already plays within ${targetClub}'s tactical structure (${fitScore}% baseline alignment across all 6 style metrics), ` +
      "so no cross-system transition risk exists."
    );
  }

  let verdict: string;
  if (fitScore >= 82) {
    verdict = `Yes — ${player} profiles as a strong tactical fit for ${targetClub}, posting an ${fitScore}% style overlap from ${currentClub}.`;
  } else if (fitScore >= 68) {
    verdict =
      `Conditionally yes — ${player} projects as a solid ${fitScore}% tactical fit for ${targetClub}, ` +
      "though specific tactical adjustments would be needed.";
  } else {
    verdict =
      `Proceed with caution — ${player} records a ${fitScore}% tactical fit score moving from ${currentClub} to ${targetClub}, ` +
      "indicating a demanding stylistic transition.";
  }

  if (!rows.length) return verdict;

  let bestDim = rows[0];
  let worstDim = rows[0];
  let strongCount = 0;
  for (const r of rows) {
    const ov = Number(r.overlap_pct);
    if (ov >= 85) strongCount += 1;
    if (ov > Number(bestDim.overlap_pct)) bestDim = r;
    if (ov < Number(worstDim.overlap_pct)) worstDim = r;
  }

  const bestLabel = cleanMetricLabel(String(bestDim.dimension));
  const worstLabel = cleanMetricLabel(String(worstDim.dimension));

  return (
    `${verdict} Across the six club-style dimensions, ${strongCount} of 6 show strong alignment — led by ` +
    `${bestLabel} (${bestDim.overlap_pct}% overlap: ${bestDim.player_team_val} vs ${bestDim.target_club_val}). ` +
    `The main adaptation gap sits in ${worstLabel}, where ${currentClub} averages ${worstDim.player_team_val} ` +
    `compared with ${targetClub}'s ${worstDim.target_club_val} (${worstDim.overlap_pct}% overlap, ${worstDim.status}), ` +
    "making that the primary coaching adjustment if signed."
  );
}

function conclusionLeagueXpts(result: ModuleResultPayload, prompt?: string | null): string {
  const cfg = result.assumptions;
  const season = String(cfg.season_name || "");
  const rows = result.table_rows || [];
  if (!rows.length) return "No match data found to evaluate table position against expected points.";

  const overperformers = rows.filter((r) => Number(r.pts_residual) >= 3.0).sort((a, b) => Number(b.pts_residual) - Number(a.pts_residual));
  const underperformers = rows.filter((r) => Number(r.pts_residual) <= -3.0).sort((a, b) => Number(a.pts_residual) - Number(b.pts_residual));

  let overperf = rows[0];
  let underperf = rows[0];
  let xptsLeader = rows[0];
  for (const r of rows) {
    if (Number(r.pts_residual) > Number(overperf.pts_residual)) overperf = r;
    if (Number(r.pts_residual) < Number(underperf.pts_residual)) underperf = r;
    if (Number(r.xpts_rank) < Number(xptsLeader.xpts_rank)) xptsLeader = r;
  }
  const actualLeader = rows[0];

  const lowPrompt = (prompt || "").toLowerCase();
  const askUnder = ["underperform", "unluck", "lower in the table", "deserve more"].some((k) => lowPrompt.includes(k));

  let lead: string;
  let contrast: string;
  if (askUnder) {
    if (underperformers.length) {
      const names = underperformers
        .slice(0, 3)
        .map((r) => `${r.team_name} (#${r.actual_rank} actual vs #${r.xpts_rank} xPTS, ${fmtSigned(Number(r.pts_residual), 1)} pts)`)
        .join(", ");
      lead = `In ${season}, the clubs most shortchanged relative to their underlying play are ${names}.`;
    } else {
      lead =
        `No club fell below the -3.0 point underperformance threshold in ${season}, though ` +
        `${underperf.team_name} had the steepest shortfall (${fmtSigned(Number(underperf.pts_residual), 1)} pts: ` +
        `${underperf.actual_pts} actual vs ${fmtFixed(Number(underperf.xpts), 1)} xPTS, #${underperf.actual_rank} vs #${underperf.xpts_rank}).`;
    }
    contrast =
      `Conversely, ${overperf.team_name} overperformed their shot quality the most ` +
      `(${overperf.actual_pts} pts from ${fmtFixed(Number(overperf.xpts), 1)} xPTS, ${fmtSigned(Number(overperf.pts_residual), 1)}, ` +
      `#${overperf.actual_rank} actual vs #${overperf.xpts_rank} xPTS)`;
  } else {
    if (overperformers.length) {
      const names = overperformers
        .slice(0, 3)
        .map((r) => `${r.team_name} (#${r.actual_rank} actual vs #${r.xpts_rank} xPTS, ${fmtSigned(Number(r.pts_residual), 1)} pts)`)
        .join(", ");
      lead = `In ${season}, the clubs sitting noticeably higher than their underlying play deserved are ${names}.`;
    } else {
      lead =
        `No club exceeded the +3.0 point overperformance threshold in ${season}, though ` +
        `${overperf.team_name} posted the largest positive margin (${fmtSigned(Number(overperf.pts_residual), 1)} pts: ` +
        `${overperf.actual_pts} actual vs ${fmtFixed(Number(overperf.xpts), 1)} xPTS, #${overperf.actual_rank} vs #${overperf.xpts_rank}).`;
    }
    contrast =
      `Conversely, ${underperf.team_name} suffered the biggest shortfall against chance quality ` +
      `(${underperf.actual_pts} pts from ${fmtFixed(Number(underperf.xpts), 1)} xPTS, ${fmtSigned(Number(underperf.pts_residual), 1)}, ` +
      `#${underperf.actual_rank} actual vs #${underperf.xpts_rank} xPTS)`;
  }

  const leaderNote =
    `${xptsLeader.team_name} led the league in underlying performance (${fmtFixed(Number(xptsLeader.xpts), 1)} xPTS, ${fmtSigned(Number(xptsLeader.xgd), 2)} xGD), ` +
    (xptsLeader.team_name === actualLeader.team_name
      ? "matching their first-place finish."
      : `despite trailing actual leaders ${actualLeader.team_name} (${actualLeader.actual_pts} pts).`);

  const focusedTeam = findMentionedTeam(
    prompt,
    rows.map((r) => String(r.team_name))
  );
  let focusNote = "";
  if (focusedTeam && focusedTeam !== overperf.team_name && focusedTeam !== underperf.team_name) {
    const matchRow = rows.find((r) => r.team_name === focusedTeam);
    if (matchRow) {
      focusNote =
        ` Specifically, ${focusedTeam} sit #${matchRow.actual_rank} (${matchRow.actual_pts} pts) ` +
        `versus #${matchRow.xpts_rank} on xPTS (${fmtFixed(Number(matchRow.xpts), 1)}, ${fmtSigned(Number(matchRow.pts_residual), 1)}, ${matchRow.status}).`;
    }
  }

  return `${lead} ${contrast}, while ${leaderNote}${focusNote}`;
}

function conclusionShotZones(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const team = String(cfg.team_name || "The team");
  const season = String(cfg.season_name || "");
  const rows = result.table_rows || [];
  const totalShots = Number(result.charts?.total_shots ?? 0);

  if (!rows.length || totalShots === 0) {
    return `No shot events were recorded for ${team} in ${season}.`;
  }

  let volZone = rows[0];
  let bestZone = rows[0];
  for (const r of rows) {
    if (Number(r.team_shots) > Number(volZone.team_shots)) volZone = r;
    if (
      Number(r.goals) > Number(bestZone.goals) ||
      (Number(r.goals) === Number(bestZone.goals) && Number(r.total_xg) > Number(bestZone.total_xg))
    ) {
      bestZone = r;
    }
  }

  const centralNames = new Set(["Six-Yard Box", "Central Penalty Area", "Left Box Channel", "Right Box Channel"]);
  let centralShare = 0;
  let lgCentralShare = 0;
  let outsideShare = 0;
  let outsideGoals = 0;
  let totalGoals = 0;
  let totalXg = 0;
  for (const r of rows) {
    totalGoals += Number(r.goals);
    totalXg += Number(r.total_xg);
    if (centralNames.has(String(r.zone))) {
      centralShare += Number(r.shot_share_pct);
      lgCentralShare += Number(r.league_share_pct);
    } else {
      outsideShare += Number(r.shot_share_pct);
      outsideGoals += Number(r.goals);
    }
  }

  const finishingDelta = totalGoals - totalXg;
  const overallConv = (100.0 * totalGoals) / Math.max(1, totalShots);

  let finishingVerdict: string;
  if (finishingDelta >= 2.0) {
    finishingVerdict = `clinical finishing (${fmtSigned(finishingDelta, 2)} goals above expected, ${fmtFixed(overallConv, 1)}% overall conversion)`;
  } else if (finishingDelta <= -2.0) {
    finishingVerdict = `below-expectation finishing (${fmtSigned(finishingDelta, 2)} goals vs xG, ${fmtFixed(overallConv, 1)}% overall conversion)`;
  } else {
    finishingVerdict = `finishing closely aligned with chance quality (${fmtSigned(finishingDelta, 2)} goals vs xG, ${fmtFixed(overallConv, 1)}% conversion)`;
  }

  return (
    `${team} took ${totalShots} shots in ${season}, directing ${fmtFixed(centralShare, 1)}% of attempts inside the penalty box ` +
    `(vs ${fmtFixed(lgCentralShare, 1)}% league avg) and concentrating their highest volume in the ${volZone.zone} ` +
    `(${volZone.team_shots} shots, ${fmtFixed(Number(volZone.shot_share_pct), 1)}% share at ${fmtFixed(Number(volZone.xg_per_shot), 2)} xG/shot). ` +
    `Their richest goal return came from the ${bestZone.zone} (${bestZone.goals} goals at ${fmtFixed(Number(bestZone.conversion_pct), 1)}% conversion ` +
    `vs ${fmtFixed(Number(bestZone.league_conversion_pct), 1)}% league avg), while outside-box and wide zones accounted for ${fmtFixed(outsideShare, 1)}% of attempts (${outsideGoals} goals). ` +
    `Across all zones, scoring ${totalGoals} goals from ${fmtFixed(totalXg, 2)} total xG reflects ${finishingVerdict}.`
  );
}

export function buildAnalysisConclusion(
  result: ModuleResultPayload,
  prompt?: string | null,
  verification?: VerificationReport | null
): string {
  let paragraph: string;
  switch (result.module_id) {
    case "managerial_impact_tracker":
      paragraph = conclusionManagerialImpact(result);
      break;
    case "tactical_intervention_comparison":
      paragraph = conclusionTacticalIntervention(result);
      break;
    case "opposition_scouting_one_pager":
      paragraph = conclusionOppositionScouting(result);
      break;
    case "multi_season_player_progression":
      paragraph = conclusionPlayerProgression(result, prompt);
      break;
    case "tactical_fit_recruitment_matcher":
      paragraph = conclusionTacticalFit(result);
      break;
    case "league_table_vs_underlying_play":
      paragraph = conclusionLeagueXpts(result, prompt);
      break;
    case "shot_location_zone_efficiency":
      paragraph = conclusionShotZones(result);
      break;
    default:
      paragraph = result.summary || "";
  }

  if (verification && !verification.all_passed) {
    paragraph = `${paragraph} (Note: ${verification.checks_passed}/${verification.checks_total} automated verification checks passed; review flagged checks before acting.)`;
  }
  return paragraph;
}
