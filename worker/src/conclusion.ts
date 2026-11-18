import type { ModuleResultPayload, VerificationReport } from "./types";

const CANONICAL_TEAMS: string[] = [
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
];

// Unambiguous club names and specific aliases only. Generic terms such as "united" or "city"
// are reported separately as ambiguous candidates rather than silently mapped to Manchester clubs.
const SPECIFIC_CLUB_ALIASES: Record<string, string> = {
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
  newcastle: "Newcastle United",
  tottenham: "Tottenham Hotspur",
  "west ham": "West Ham United",
  brighton: "Brighton & Hove Albion",
  arsenal: "Arsenal",
  chelsea: "Chelsea",
  liverpool: "Liverpool",
  spurs: "Tottenham Hotspur",
  villa: "Aston Villa",
};

function fmtSigned(val: number, decimals: number): string {
  const clean = Math.abs(val) < 0.5 * Math.pow(10, -decimals) ? 0 : val;
  const sign = clean < 0 ? "-" : "+";
  return `${sign}${Math.abs(clean).toFixed(decimals)}`;
}

function fmtSignedInt(val: number): string {
  const n = Math.trunc(val);
  return n < 0 ? `${n}` : `+${n}`;
}

function fmtFixed(val: number, decimals: number): string {
  const clean = Math.abs(val) < 0.5 * Math.pow(10, -decimals) ? 0 : val;
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

function spansOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

export interface ClubMentionsResult {
  matched_teams: string[];
  ambiguous_term: string | null;
  ambiguous_candidates: string[];
}

export function extractClubMentions(
  prompt: string | null | undefined,
  teamNames?: string[] | null
): ClubMentionsResult {
  const activeTeams = teamNames && teamNames.length ? [...teamNames] : [...CANONICAL_TEAMS];
  const activeSet = new Set(activeTeams);

  if (!prompt) {
    return { matched_teams: [], ambiguous_term: null, ambiguous_candidates: [] };
  }

  const low = prompt.toLowerCase();
  const phraseMap = new Map<string, string>();
  for (const [alias, canon] of Object.entries(SPECIFIC_CLUB_ALIASES)) {
    if (activeSet.has(canon)) {
      phraseMap.set(alias, canon);
    }
  }
  for (const t of activeTeams) {
    const tLow = t.toLowerCase();
    if (tLow !== "united" && tLow !== "city" && !phraseMap.has(tLow)) {
      phraseMap.set(tLow, t);
    }
  }

  const sortedPhrases = Array.from(phraseMap.entries()).sort(
    (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0])
  );

  const claimedSpans: Array<[number, number]> = [];
  const spanHits: Array<[number, string]> = [];

  for (const [phrase, canon] of sortedPhrases) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(phrase)}(?![a-z0-9])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(low)) !== null) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (!claimedSpans.some((c) => spansOverlap(span, c))) {
        claimedSpans.push(span);
        spanHits.push([m.index, canon]);
      }
    }
  }

  spanHits.sort((a, b) => a[0] - b[0]);
  const matchedTeams: string[] = [];
  for (const [, canon] of spanHits) {
    if (!matchedTeams.includes(canon)) {
      matchedTeams.push(canon);
    }
  }

  let ambiguousTerm: string | null = null;
  let ambiguousCandidates: string[] = [];
  for (const [token, displayTok] of [
    ["united", "United"],
    ["city", "City"],
  ] as const) {
    const re = new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`, "g");
    let hasUnclaimed = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(low)) !== null) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (!claimedSpans.some((c) => spansOverlap(span, c))) {
        hasUnclaimed = true;
        break;
      }
    }
    if (hasUnclaimed) {
      const cands = activeTeams.filter((t) => t.toLowerCase().includes(token));
      if (cands.length > 1 || (cands.length === 1 && matchedTeams.length === 0)) {
        ambiguousTerm = displayTok;
        ambiguousCandidates = cands;
        break;
      }
    }
  }

  return {
    matched_teams: matchedTeams,
    ambiguous_term: ambiguousTerm,
    ambiguous_candidates: ambiguousCandidates,
  };
}

export function findMentionedTeam(prompt: string | null | undefined, teamNames: string[]): string | null {
  const resolved = extractClubMentions(prompt, teamNames);
  return resolved.matched_teams.length ? resolved.matched_teams[0] : null;
}

function roundTo(val: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  const rounded = Math.round((val + Number.EPSILON) * p) / p;
  return Object.is(rounded, -0) ? 0 : rounded;
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
    return `Insufficient match data to evaluate ${team} in ${season}: 0 matches were found for this club and season.`;
  }

  const before = rows[0];
  const after = rows[1];
  const beforeMatches = Math.trunc(Number(before.matches ?? 0));
  const afterMatches = Math.trunc(Number(after.matches ?? 0));
  const splitMw = milestones.length ? Number(milestones[0].match_week) : Number(cfg.milestone_match_week ?? 10);

  if (beforeMatches <= 0 && afterMatches <= 0) {
    return `Insufficient match data to evaluate ${team} in ${season}: 0 matches were found for this club and season.`;
  }
  if (beforeMatches <= 0) {
    return (
      `Insufficient pre-split sample to compare ${team} in ${season} around Matchweek ${splitMw}: ` +
      `0 matches were recorded before MW ${splitMw} (${afterMatches} matches from MW ${splitMw} onward).`
    );
  }
  if (afterMatches <= 0) {
    return (
      `Insufficient post-split sample to compare ${team} in ${season} around Matchweek ${splitMw}: ` +
      `0 matches were recorded from MW ${splitMw} onward (${beforeMatches} matches before MW ${splitMw}).`
    );
  }

  const prevMgr = milestones.length ? milestones[0].previous_manager : null;
  const newMgr = milestones.length ? milestones[0].new_manager : null;

  let shiftDesc = `since Matchweek ${splitMw}`;
  if (prevMgr && newMgr && prevMgr !== newMgr) {
    shiftDesc = `since ${newMgr} replaced ${prevMgr} at Matchweek ${splitMw}`;
  } else if (newMgr) {
    shiftDesc = `since the Matchweek ${splitMw} shift under ${newMgr}`;
  }

  const beforePpg = Number(before.ppg);
  const afterPpg = Number(after.ppg);
  const beforeXgd = Number(before.xg_diff_per90);
  const afterXgd = Number(after.xg_diff_per90);
  const beforeXgf = Number(before.xgf_per90);
  const afterXgf = Number(after.xgf_per90);
  const beforeXga = Number(before.xga_per90);
  const afterXga = Number(after.xga_per90);

  const ppgDelta = roundTo(afterPpg - beforePpg, 2);
  const xgdDelta = roundTo(afterXgd - beforeXgd, 2);
  const xgfDelta = roundTo(afterXgf - beforeXgf, 2);
  const xgaDelta = roundTo(afterXga - beforeXga, 2);

  const xgdDir = xgdDelta > 0.08 ? "up" : xgdDelta < -0.08 ? "down" : "flat";
  const ppgDir = ppgDelta > 0.15 ? "up" : ppgDelta < -0.15 ? "down" : "flat";

  const verdictMap: Record<string, string> = {
    "up|up":
      `Yes — ${team} show an overall upward shift ${shiftDesc} (${season}), ` +
      "with both points output and underlying xG differential rising.",
    "up|flat":
      `Partially — ${team}'s underlying xG differential has improved ${shiftDesc} (${season}), ` +
      "while points per game have stayed broadly flat.",
    "up|down":
      `Mixed — ${team}'s underlying xG differential has improved ${shiftDesc} (${season}), ` +
      "even though points per game have declined.",
    "flat|up":
      `Partially — ${team}'s points per game have risen ${shiftDesc} (${season}), ` +
      "while underlying xG differential has remained nearly flat.",
    "flat|flat":
      `${team}'s trajectory has held steady ${shiftDesc} (${season}), ` +
      "with minimal change in either points per game or underlying xG differential.",
    "flat|down":
      `Partially — ${team}'s points per game have declined ${shiftDesc} (${season}), ` +
      "even though underlying xG differential has remained nearly flat.",
    "down|up":
      `Mixed — ${team}'s points per game have risen ${shiftDesc} (${season}), ` +
      "but underlying xG differential has declined.",
    "down|flat":
      `No — ${team}'s underlying xG differential has declined ${shiftDesc} (${season}), ` +
      "while points per game have held broadly steady.",
    "down|down":
      `No — ${team} have declined ${shiftDesc} (${season}) ` +
      "in both points per game and underlying xG differential.",
  };
  const verdict = verdictMap[`${xgdDir}|${ppgDir}`];

  const latest = timeline.length ? timeline[timeline.length - 1] : null;
  const rollingTail = latest
    ? `, leaving their latest ${window}-match rolling form at ${fmtFixed(Number(latest.rolling_ppg), 2)} PPG (${fmtFixed(Number(latest.rolling_xgf), 2)} xGF vs ${fmtFixed(Number(latest.rolling_xga), 2)} xGA)`
    : "";

  const xgfDir = xgfDelta > 0.05 ? "up" : xgfDelta < -0.05 ? "down" : "flat";
  const xgaDir = xgaDelta > 0.05 ? "up" : xgaDelta < -0.05 ? "down" : "flat";

  const componentTakeaways: Record<string, string> = {
    "up|down":
      `both xG components moved favourably (attacking xGF rose ${fmtSigned(xgfDelta, 2)}/match from ` +
      `${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}, while xGA conceded fell ${fmtSigned(xgaDelta, 2)}/match from ${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}).`,
    "up|flat":
      `the xG differential rise came from attacking xGF increasing by ${fmtSigned(xgfDelta, 2)}/match ` +
      `(${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}), while xGA conceded remained nearly flat (${fmtFixed(beforeXga, 2)} vs ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}).`,
    "flat|down":
      `the xG differential improvement came from lower xGA conceded (${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}/match) ` +
      `rather than higher attacking xGF, which remained nearly flat (${fmtFixed(beforeXgf, 2)} vs ${fmtFixed(afterXgf, 2)}, ${fmtSigned(xgfDelta, 2)}).`,
    "up|up":
      `both attacking xGF (${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}, ${fmtSigned(xgfDelta, 2)}/match) and xGA conceded ` +
      `(${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}/match) increased across these fixtures.`,
    "down|down":
      `both attacking xGF (${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}, ${fmtSigned(xgfDelta, 2)}/match) and xGA conceded ` +
      `(${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}/match) decreased across these fixtures.`,
    "down|flat":
      `the lower xG differential stemmed from attacking xGF dropping by ${fmtSigned(xgfDelta, 2)}/match ` +
      `(${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}) while xGA conceded stayed nearly flat (${fmtFixed(beforeXga, 2)} vs ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}), ` +
      "rather than higher xG conceded.",
    "flat|up":
      `the lower xG differential stemmed from xGA conceded rising by ${fmtSigned(xgaDelta, 2)}/match ` +
      `(${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}) while attacking xGF held nearly steady (${fmtFixed(beforeXgf, 2)} vs ${fmtFixed(afterXgf, 2)}, ${fmtSigned(xgfDelta, 2)}).`,
    "down|up":
      `both xG components moved unfavourably: attacking xGF fell by ${fmtSigned(xgfDelta, 2)}/match ` +
      `(${fmtFixed(beforeXgf, 2)} to ${fmtFixed(afterXgf, 2)}) while xGA conceded rose by ${fmtSigned(xgaDelta, 2)}/match (${fmtFixed(beforeXga, 2)} to ${fmtFixed(afterXga, 2)}).`,
    "flat|flat":
      `both underlying components stayed within a narrow band (xGF ${fmtFixed(beforeXgf, 2)} → ${fmtFixed(afterXgf, 2)}, ${fmtSigned(xgfDelta, 2)}; ` +
      `xGA ${fmtFixed(beforeXga, 2)} → ${fmtFixed(afterXga, 2)}, ${fmtSigned(xgaDelta, 2)}).`,
  };
  const takeaway = componentTakeaways[`${xgfDir}|${xgaDir}`];

  const limitation =
    Math.min(beforeMatches, afterMatches) < 5 ||
    (xgdDir === "down" && ppgDir === "up") ||
    (xgdDir === "up" && ppgDir === "down")
      ? ` Note: this descriptive split (n=${beforeMatches} vs n=${afterMatches}) does not adjust for opponent strength or match-state variance.`
      : "";

  return (
    `${verdict} Across ${afterMatches} matches from MW ${splitMw} onward (vs ${beforeMatches} before), ` +
    `points per game moved from ${fmtFixed(beforePpg, 2)} to ${fmtFixed(afterPpg, 2)} (${fmtSigned(ppgDelta, 2)}), ` +
    `with goals scored moving ${fmtFixed(Number(before.gf_per90), 2)} → ${fmtFixed(Number(after.gf_per90), 2)} and goals conceded ` +
    `${fmtFixed(Number(before.ga_per90), 2)} → ${fmtFixed(Number(after.ga_per90), 2)} per match. ` +
    `Under the hood, xG differential shifted ${fmtSigned(beforeXgd, 2)} → ${fmtSigned(afterXgd, 2)} per match (${fmtSigned(xgdDelta, 2)}; ` +
    `xGF ${fmtFixed(beforeXgf, 2)} → ${fmtFixed(afterXgf, 2)}, xGA ${fmtFixed(beforeXga, 2)} → ${fmtFixed(afterXga, 2)})` +
    `${rollingTail} — ${takeaway}${limitation}`
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
  const matches = Math.trunc(Number(mw.matches ?? 0));
  const seasonMatches = Math.trunc(Number(mw.season_matches ?? matches));
  const radar = (charts.radar as Array<Record<string, any>>) || [];

  if (seasonMatches <= 0) {
    return (
      `Insufficient data to assess ${team} in ${season}: 0 season matches were found for this club, ` +
      `so MW ${startMw}–${endMw} cannot be compared against a ${season} baseline.`
    );
  }
  if (matches <= 0 || !radar.length) {
    return (
      `Insufficient match sample to evaluate ${team} during MW ${startMw}–${endMw} in ${season}: ` +
      `0 matches were played in that window, so no tactical comparison against the ${season} baseline can be made.`
    );
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
      `Yes — ${team} showed a clear tactical shift during MW ${startMw}–${endMw} (${matches} matches) ` +
      `versus their ${season} norm, led by a ${fmtSignedInt(topPctDelta)}-percentile move in ${metricLower}.`;
  } else if (maxAbsShift >= 7) {
    verdict =
      `${team} showed moderate tactical shifts during MW ${startMw}–${endMw} (${matches} matches) ` +
      `rather than a complete overhaul, with the biggest swing in ${metricLower} (${fmtSignedInt(topPctDelta)} percentile pts).`;
  } else {
    verdict =
      `Very little shifted structurally for ${team} during MW ${startMw}–${endMw} (${matches} matches); ` +
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

  const matchesPlayed = Math.trunc(Number(kpis.matches_played ?? 0));
  if (matchesPlayed <= 0) {
    return (
      `Insufficient data to scout ${opp} in ${season}: ` +
      "0 matches or events were found for this club in the connected dataset."
    );
  }

  const ppda = Number(kpis.ppda);
  const poss = Number(kpis.possession_share);
  const direct = Number(kpis.build_up_directness);
  const xg90 = Number(kpis.xg_per90);

  const rawShape = formations.length ? formations[0].formation : null;
  const hasShape = rawShape !== null && rawShape !== undefined && !["", "None"].includes(String(rawShape).trim());
  const shapeClause = hasShape ? `built around a ${rawShape} base ` : "with no recorded starting formation ";

  const pressStyle = ppda < 9.5 ? "high-pressing" : ppda <= 12.5 ? "selective mid-press" : "compact mid-to-low block";
  const ballStyle = poss >= 54.0 ? "possession-dominant" : poss >= 47.0 ? "balanced" : "transition-oriented";

  const activeZones = zones.filter((z) => !["", "0"].includes(String(z.value_label ?? "0").trim()));
  let topZone = activeZones[0] ?? null;
  for (const z of activeZones) {
    if (topZone && Number(z.intensity) > Number(topZone.intensity)) topZone = z;
  }
  const zoneClause = topZone
    ? `Their defensive actions concentrate most in the ${topZone.zone_id} (${topZone.value_label} triggers)`
    : "No defensive-action trigger zones were recorded";

  const observedRows = (result.table_rows || []).filter((r) => Math.trunc(Number(r.events ?? 0)) > 0);
  const states: Record<string, Record<string, any>> = {};
  for (const r of observedRows) {
    states[String(r.match_state).toLowerCase()] = r;
  }

  const winState = states.winning;
  const loseState = states.losing;
  let stateClause: string;

  if (
    winState &&
    loseState &&
    winState.avg_def_line_m !== null &&
    winState.avg_def_line_m !== undefined &&
    loseState.avg_def_line_m !== null &&
    loseState.avg_def_line_m !== undefined
  ) {
    const winX = Number(winState.avg_def_line_m);
    const loseX = Number(loseState.avg_def_line_m);
    const winDir = Number(winState.directness_pct);
    const loseDir = Number(loseState.directness_pct);
    const diffX = roundTo(winX - loseX, 1);

    if (diffX >= 1.0) {
      stateClause =
        `, while their event-derived average defensive-action location sits higher when leading (${fmtFixed(winX, 1)}m, ` +
        `${fmtFixed(winDir, 1)}% long-pass directness) than when chasing (${fmtFixed(loseX, 1)}m, ${fmtFixed(loseDir, 1)}% directness).`;
    } else if (diffX <= -1.0) {
      stateClause =
        `, while their event-derived average defensive-action location sits deeper when leading (${fmtFixed(winX, 1)}m, ` +
        `${fmtFixed(winDir, 1)}% long-pass directness) than when chasing (${fmtFixed(loseX, 1)}m, ${fmtFixed(loseDir, 1)}% directness).`;
    } else if (Math.abs(diffX) < 0.05) {
      stateClause =
        `, while their average defensive-action location is identical when leading and chasing (${fmtFixed(winX, 1)}m; ` +
        `${fmtFixed(winDir, 1)}% long-pass directness leading vs ${fmtFixed(loseDir, 1)}% chasing).`;
    } else {
      stateClause =
        `, while their average defensive-action location differs only slightly by game state ` +
        `(${fmtFixed(winX, 1)}m with ${fmtFixed(winDir, 1)}% long-pass directness when leading vs ` +
        `${fmtFixed(loseX, 1)}m with ${fmtFixed(loseDir, 1)}% directness when chasing, below a 1.0m threshold).`;
    }
  } else if (observedRows.length > 0) {
    const parts = observedRows.map((r) => {
      const loc =
        r.avg_def_line_m !== null && r.avg_def_line_m !== undefined
          ? `${fmtFixed(Number(r.avg_def_line_m), 1)}m avg defensive-action x`
          : "no defensive-action x recorded";
      return `${String(r.match_state).toLowerCase()} (${loc}, ${fmtFixed(Number(r.directness_pct), 1)}% directness)`;
    });
    stateClause =
      `, with match-state events recorded only while ${parts.join(", ")} ` +
      "(insufficient state coverage to compare leading versus chasing).";
  } else {
    stateClause = ", with no match-state breakdown recorded.";
  }

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
    `${opp} (${season}, ${matchesPlayed} matches) project as a ${ballStyle}, ${pressStyle} opponent ${shapeClause}` +
    `(${fmtFixed(ppda, 2)} PPDA, ${fmtFixed(poss, 1)}% possession, ${fmtFixed(direct, 1)}% long build-up share, generating ${fmtFixed(xg90, 2)} xG/90). ` +
    `${zoneClause}${stateClause}${threatClause}`
  );
}

function conclusionPlayerProgression(
  result: ModuleResultPayload,
  prompt?: string | null,
  focusPlayer?: string | null
): string {
  const cfg = result.assumptions;
  const s1 = String(cfg.season_1 || "2023/2024");
  const s2 = String(cfg.season_2 || "2024/2025");
  const minMins = Number(cfg.min_minutes ?? 450);
  const charts = result.charts || {};
  const norm = String(charts.normalisation ?? cfg.normalisation ?? "per_90");
  const comp = String(charts.composite ?? cfg.skill_composite ?? "ball_progression").replace(/_/g, " ");
  const totalQ = Math.trunc(Number(charts.total_qualifiers ?? 0));
  const ranked = result.table_rows || [];

  if (!ranked.length || totalQ <= 0) {
    return (
      `Insufficient qualifying player sample between ${s1} and ${s2}: ` +
      `0 players logged at least ${minMins} minutes in both seasons.`
    );
  }

  const normLabel = norm === "possession_adjusted" ? "possession-adjusted (PAdj)" : "per-90";
  const p1 = ranked[0];
  const p1Delta = Number(p1.delta);
  let lead: string;
  if (p1Delta > 0) {
    lead =
      `Across ${totalQ} qualifying players (>= ${minMins} minutes in both ${s1} and ${s2}, ${normLabel}), ` +
      `${p1.player_name} (${p1.team_name}, ${p1.position}) improved the most in ${comp}, ` +
      `rising ${fmtSigned(p1Delta, 2)} points (${fmtSigned(Number(p1.pct_change), 1)}%) ` +
      `from ${fmtFixed(Number(p1.season_1_score), 2)} to ${fmtFixed(Number(p1.season_2_score), 2)}.`;
  } else if (p1Delta === 0) {
    lead =
      `Across ${totalQ} qualifying players (>= ${minMins} minutes in both ${s1} and ${s2}, ${normLabel}), ` +
      `no player recorded a positive gain in ${comp}, with ${p1.player_name} (${p1.team_name}, ${p1.position}) ` +
      `holding steady at ${fmtFixed(Number(p1.season_2_score), 2)} (${fmtSigned(p1Delta, 2)}).`;
  } else {
    lead =
      `Across ${totalQ} qualifying players (>= ${minMins} minutes in both ${s1} and ${s2}, ${normLabel}), ` +
      `every qualifier declined in ${comp}, with ${p1.player_name} (${p1.team_name}, ${p1.position}) ` +
      `posting the smallest drop at ${fmtSigned(p1Delta, 2)} points (${fmtSigned(Number(p1.pct_change), 1)}%, from ${fmtFixed(Number(p1.season_1_score), 2)} to ${fmtFixed(Number(p1.season_2_score), 2)}).`;
  }

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
  const targetHint = focusPlayer !== undefined ? (focusPlayer ? focusPlayer.toLowerCase() : null) : prompt ? prompt.toLowerCase() : null;
  if (targetHint) {
    for (let i = 1; i < ranked.length; i++) {
      const row = ranked[i];
      const pname = String(row.player_name);
      const parts = pname.split(/\s+/);
      const last = parts[parts.length - 1].toLowerCase();
      const lastRe = new RegExp(`(?<![a-z0-9])${escapeRegex(last)}(?![a-z0-9])`, "i");
      if (targetHint.includes(pname.toLowerCase()) || (focusPlayer === undefined && last.length >= 4 && lastRe.test(targetHint))) {
        namedNote =
          ` For your named player, ${pname} (${row.team_name}) placed #${i + 1} ` +
          `with a ${fmtSigned(Number(row.delta), 2)} change (${fmtFixed(Number(row.season_1_score), 2)} → ${fmtFixed(Number(row.season_2_score), 2)}).`;
        break;
      }
    }
  }

  return `${lead}${runners}${namedNote} Every ranked player met the ${minMins}-minute floor in both seasons.`;
}

function conclusionTacticalFit(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const season = String(cfg.season_name || "");
  const charts = result.charts || {};
  const player = String(charts.player_name || "The target player");
  const currentClub = String(charts.current_club || "their current club");
  const targetClub = String(charts.target_club || "the target club");
  const rows = result.table_rows || [];

  if (charts.player_matched === false) {
    const reqPlayer = String(charts.requested_player || cfg.player_name || player);
    return (
      `Insufficient data to evaluate tactical fit for ${reqPlayer} in ${season}: ` +
      "player was not found in the squad catalog."
    );
  }

  const currMatches = Math.trunc(Number(charts.current_club_matches ?? 1));
  const targMatches = Math.trunc(Number(charts.target_club_matches ?? 1));
  if (currMatches <= 0 || targMatches <= 0 || !rows.length || charts.fit_score === null || charts.fit_score === undefined) {
    return (
      `Insufficient match data in ${season} to evaluate tactical fit for ${player} ` +
      `(${currentClub}: ${currMatches} matches; ${targetClub}: ${targMatches} matches).`
    );
  }

  const fitScore = Number(charts.fit_score);

  if (currentClub === targetClub) {
    return (
      `${player} already plays within ${targetClub}'s tactical profile (${fitScore}% baseline alignment across all 6 team style metrics in ${season}), ` +
      "meaning current and target team environments match directly."
    );
  }

  let verdict: string;
  if (fitScore >= 82) {
    verdict = `High style overlap — ${player}'s current club (${currentClub}) shares a ${fitScore}% team-style overlap with ${targetClub}.`;
  } else if (fitScore >= 68) {
    verdict =
      `Moderate style overlap — ${player}'s current club (${currentClub}) shares a ${fitScore}% team-style overlap with ${targetClub}, ` +
      "with specific metric gaps to account for.";
  } else {
    verdict =
      `Low style overlap — ${player}'s current club (${currentClub}) shares a ${fitScore}% team-style overlap with ${targetClub}, ` +
      "indicating distinct team style demands.";
  }

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
    `${verdict} Across the six club-style dimensions, ${strongCount} of 6 show strong alignment — closest on ` +
    `${bestLabel} (${bestDim.overlap_pct}% overlap: ${bestDim.player_team_val} vs ${bestDim.target_club_val}). ` +
    `The widest gap sits in ${worstLabel}, where ${currentClub} averages ${worstDim.player_team_val} ` +
    `compared with ${targetClub}'s ${worstDim.target_club_val} (${worstDim.overlap_pct}% overlap, ${worstDim.status}).`
  );
}

function conclusionLeagueXpts(
  result: ModuleResultPayload,
  prompt?: string | null,
  focusTeam?: string | null
): string {
  const cfg = result.assumptions;
  const season = String(cfg.season_name || "");
  const rows = result.table_rows || [];
  if (!rows.length) {
    return (
      `Insufficient match data in ${season} to evaluate league table position against expected points ` +
      "(0 matches found)."
    );
  }

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

  const rowTeamNames = rows.map((r) => String(r.team_name));
  const resolvedFocus =
    focusTeam !== undefined
      ? focusTeam && rowTeamNames.includes(focusTeam)
        ? focusTeam
        : null
      : findMentionedTeam(prompt, rowTeamNames);

  let focusedLead = "";
  if (resolvedFocus) {
    const matchRow = rows.find((r) => r.team_name === resolvedFocus);
    if (matchRow) {
      focusedLead =
        `In ${season}, ${resolvedFocus} sit #${matchRow.actual_rank} in the actual table ` +
        `(${matchRow.actual_pts} pts across ${matchRow.mp} matches) versus #${matchRow.xpts_rank} on simulated xPTS ` +
        `(${fmtFixed(Number(matchRow.xpts), 1)} xPTS, ${fmtSigned(Number(matchRow.pts_residual), 1)} pts, ${matchRow.status}; ` +
        `${fmtFixed(Number(matchRow.xgf), 2)} xGF vs ${fmtFixed(Number(matchRow.xga), 2)} xGA, ${fmtSigned(Number(matchRow.xgd), 2)} xGD). `;
    }
  }

  const scopePrefix = focusedLead ? "League-wide," : `In ${season},`;
  const noThreshPrefix = focusedLead ? "League-wide, no club" : "No club";

  let lead: string;
  let contrast: string;
  if (askUnder) {
    if (underperformers.length) {
      const names = underperformers
        .slice(0, 3)
        .map((r) => `${r.team_name} (#${r.actual_rank} actual vs #${r.xpts_rank} xPTS, ${fmtSigned(Number(r.pts_residual), 1)} pts)`)
        .join(", ");
      lead = `${scopePrefix} the clubs most shortchanged relative to their underlying play are ${names}.`;
    } else {
      lead =
        `${noThreshPrefix} fell below the -3.0 point underperformance threshold in ${season}, though ` +
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
      lead = `${scopePrefix} the clubs sitting noticeably higher than their underlying play suggested are ${names}.`;
    } else {
      lead =
        `${noThreshPrefix} exceeded the +3.0 point overperformance threshold in ${season}, though ` +
        `${overperf.team_name} posted the largest positive margin (${fmtSigned(Number(overperf.pts_residual), 1)} pts: ` +
        `${overperf.actual_pts} actual vs ${fmtFixed(Number(overperf.xpts), 1)} xPTS, #${overperf.actual_rank} vs #${overperf.xpts_rank}).`;
    }
    contrast =
      `Conversely, ${underperf.team_name} suffered the biggest shortfall against chance quality ` +
      `(${underperf.actual_pts} pts from ${fmtFixed(Number(underperf.xpts), 1)} xPTS, ${fmtSigned(Number(underperf.pts_residual), 1)}, ` +
      `#${underperf.actual_rank} actual vs #${underperf.xpts_rank} xPTS)`;
  }

  const leaderNote =
    `${xptsLeader.team_name} led the league in underlying xPTS (${fmtFixed(Number(xptsLeader.xpts), 1)} xPTS, ${fmtSigned(Number(xptsLeader.xgd), 2)} xGD), ` +
    (xptsLeader.team_name === actualLeader.team_name
      ? "matching their first-place finish."
      : `despite trailing actual leaders ${actualLeader.team_name} (${actualLeader.actual_pts} pts).`);

  return `${focusedLead}${lead} ${contrast}, while ${leaderNote}`;
}

function conclusionShotZones(result: ModuleResultPayload): string {
  const cfg = result.assumptions;
  const team = String(cfg.team_name || "The team");
  const season = String(cfg.season_name || "");
  const rows = result.table_rows || [];
  const totalShots = Math.trunc(Number(result.charts?.total_shots ?? 0));

  if (!rows.length || totalShots <= 0) {
    return (
      `Insufficient shot data for ${team} in ${season}: ` +
      "0 shot events were recorded for this club and season."
    );
  }

  let volZone = rows[0];
  let bestZone = rows[0];
  let topXgZone = rows[0];
  for (const r of rows) {
    if (Number(r.team_shots) > Number(volZone.team_shots)) volZone = r;
    if (
      Number(r.goals) > Number(bestZone.goals) ||
      (Number(r.goals) === Number(bestZone.goals) && Number(r.total_xg) > Number(bestZone.total_xg))
    ) {
      bestZone = r;
    }
    if (
      Number(r.total_xg) > Number(topXgZone.total_xg) ||
      (Number(r.total_xg) === Number(topXgZone.total_xg) && Number(r.team_shots) > Number(topXgZone.team_shots))
    ) {
      topXgZone = r;
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
    finishingVerdict = `above-expectation conversion (${fmtSigned(finishingDelta, 2)} goals above xG, ${fmtFixed(overallConv, 1)}% overall conversion)`;
  } else if (finishingDelta <= -2.0) {
    finishingVerdict = `below-expectation conversion (${fmtSigned(finishingDelta, 2)} goals vs xG, ${fmtFixed(overallConv, 1)}% overall conversion)`;
  } else {
    finishingVerdict = `goal conversion closely aligned with chance quality (${fmtSigned(finishingDelta, 2)} goals vs xG, ${fmtFixed(overallConv, 1)}% conversion)`;
  }

  const goalClause =
    totalGoals === 0
      ? `They recorded 0 goals across those ${totalShots} shots, generating their highest xG total in the ` +
        `${topXgZone.zone} (${topXgZone.team_shots} shots, ${fmtFixed(Number(topXgZone.total_xg), 2)} xG at ${fmtFixed(Number(topXgZone.xg_per_shot), 2)} xG/shot).`
      : `Their highest goal return came from the ${bestZone.zone} (${bestZone.goals} goals at ${fmtFixed(Number(bestZone.conversion_pct), 1)}% conversion ` +
        `vs ${fmtFixed(Number(bestZone.league_conversion_pct), 1)}% league avg), while outside-box and wide zones accounted for ${fmtFixed(outsideShare, 1)}% of attempts (${outsideGoals} goals).`;

  return (
    `${team} took ${totalShots} shots in ${season}, directing ${fmtFixed(centralShare, 1)}% of attempts inside the penalty box ` +
    `(vs ${fmtFixed(lgCentralShare, 1)}% league avg) and concentrating their highest volume in the ${volZone.zone} ` +
    `(${volZone.team_shots} shots, ${fmtFixed(Number(volZone.shot_share_pct), 1)}% share at ${fmtFixed(Number(volZone.xg_per_shot), 2)} xG/shot). ` +
    `${goalClause} ` +
    `Across all zones, scoring ${totalGoals} goals from ${fmtFixed(totalXg, 2)} total xG reflects ${finishingVerdict}.`
  );
}

export function buildAnalysisConclusion(
  result: ModuleResultPayload,
  prompt?: string | null,
  verification?: VerificationReport | null,
  focusTeam?: string | null,
  focusPlayer?: string | null
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
      paragraph = conclusionPlayerProgression(result, prompt, focusPlayer);
      break;
    case "tactical_fit_recruitment_matcher":
      paragraph = conclusionTacticalFit(result);
      break;
    case "league_table_vs_underlying_play":
      paragraph = conclusionLeagueXpts(result, prompt, focusTeam);
      break;
    case "shot_location_zone_efficiency":
      paragraph = conclusionShotZones(result);
      break;
    default:
      paragraph = result.summary || "";
  }

  if (verification && !verification.all_passed) {
    paragraph = `${paragraph} (Verification warning: only ${verification.checks_passed}/${verification.checks_total} automated verification checks passed; review flagged checks before acting.)`;
  }
  return paragraph;
}
