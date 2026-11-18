import { buildAnalysisConclusion } from "./conclusion";
import { compensatedSum, roundHalfAway, roundHalfToEven } from "./data";
import type {
  AssumptionsConfig,
  CoordGrid,
  DatasetStore,
  EventRow,
  MatchRow,
  ModuleId,
  ModuleResultPayload,
  VerificationCheck,
  VerificationReport,
} from "./types";

export const DEFAULT_ASSUMPTIONS: AssumptionsConfig = {
  season_name: "2024/2025",
  season_1: "2023/2024",
  season_2: "2024/2025",
  team_name: "Manchester United",
  opponent_name: "Arsenal",
  player_name: "Cole Palmer",
  target_club: "Arsenal",
  min_minutes: 450,
  normalisation: "per_90",
  coord_grid: "120x80",
  rolling_window: 4,
  milestone_match_week: 10,
  start_mw: 10,
  end_mw: 18,
  ppda_def_line_x: 42.0,
  high_turnover_x_threshold: 65.0,
  prog_pass_min_dist: 10.0,
  skill_composite: "ball_progression",
};

export function mergeAssumptions(overrides?: Record<string, unknown> | null): AssumptionsConfig {
  const cfg: Record<string, unknown> = { ...DEFAULT_ASSUMPTIONS };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== null && v !== undefined) {
        cfg[k] = v;
      }
    }
  }
  return cfg as unknown as AssumptionsConfig;
}

function coordPair(x120: number, y80: number, x105: number, y68: number, grid: CoordGrid): [number, number] {
  return grid === "105x68"
    ? [roundHalfToEven(x105, 2), roundHalfToEven(y68, 2)]
    : [roundHalfToEven(x120, 2), roundHalfToEven(y80, 2)];
}

function fmtSigned(val: number, decimals: number): string {
  const clean = Object.is(val, -0) ? 0 : val;
  const sign = clean < 0 ? "-" : "+";
  return `${sign}${Math.abs(clean).toFixed(decimals)}`;
}

function fmtFixed(val: number, decimals: number): string {
  const clean = Object.is(val, -0) ? 0 : val;
  return clean.toFixed(decimals);
}

interface TeamStyleProfile {
  matches_played: number;
  possession_share: number;
  ppda: number;
  build_up_directness: number;
  high_turnovers_per90: number;
  progressive_passes_per90: number;
  box_entries_per90: number;
  xg_per90: number;
}

function computeTeamStyleProfile(
  store: DatasetStore,
  teamName: string,
  seasonName: string,
  assumptions: AssumptionsConfig,
  mwStart?: number,
  mwEnd?: number
): TeamStyleProfile {
  const ppdaX = Number(assumptions.ppda_def_line_x);
  const htX = Number(assumptions.high_turnover_x_threshold);
  const progD = Number(assumptions.prog_pass_min_dist);
  const hasMwRange = mwStart !== undefined && mwStart !== null && mwEnd !== undefined && mwEnd !== null;
  const sMw = hasMwRange ? Math.trunc(Number(mwStart)) : 0;
  const eMw = hasMwRange ? Math.trunc(Number(mwEnd)) : 0;

  const scopedMatches: MatchRow[] = [];
  for (const m of store.matches) {
    if (m.season_name !== seasonName) continue;
    if (m.home_team_name !== teamName && m.away_team_name !== teamName) continue;
    if (hasMwRange && (m.match_week < sMw || m.match_week > eMw)) continue;
    scopedMatches.push(m);
  }

  let matchesWithEvents = 0;
  let totalPoss = 0;
  let teamPoss = 0;
  let teamPasses = 0;
  let progPasses = 0;
  let longPasses = 0;
  let boxEntries = 0;
  let xgFor = 0;
  let highDefActions = 0;
  let highTurnovers = 0;
  let oppBuildupPasses = 0;

  for (const m of scopedMatches) {
    const evs = store.eventsByMatchId.get(m.match_id);
    if (!evs || evs.length === 0) continue;
    matchesWithEvents += 1;

    const seenPoss = new Set<string>();
    for (const e of evs) {
      const pKey = `${e.possession}\u0000${e.possession_team_name}`;
      if (!seenPoss.has(pKey)) {
        seenPoss.add(pKey);
        totalPoss += 1;
        if (e.possession_team_name === teamName) teamPoss += 1;
      }

      if (e.team_name === teamName) {
        if (e.event_type === "Pass") {
          teamPasses += 1;
          if (e.pass_height === "High Pass") longPasses += 1;
          if (e.outcome === "Complete") {
            const ex105 = e.end_x_105 ?? e.x_105;
            const ey105 = e.end_y_105 ?? e.y_105;
            const startDist = Math.hypot(105.0 - e.x_105, 34.0 - e.y_105);
            const endDist = Math.hypot(105.0 - ex105, 34.0 - ey105);
            if (startDist - endDist >= progD) progPasses += 1;
          }
        }
        if (e.is_box_entry) boxEntries += 1;
        if (e.event_type === "Shot") xgFor += e.xg;
        if (e.is_defensive_action && e.x_105 >= ppdaX) highDefActions += 1;
        if (
          (e.event_type === "Interception" || e.event_type === "Ball Recovery" || e.event_type === "Duel") &&
          e.x_105 >= htX
        ) {
          highTurnovers += 1;
        }
      } else {
        if (e.event_type === "Pass" && e.outcome === "Complete" && 105.0 - e.x_105 >= ppdaX) {
          oppBuildupPasses += 1;
        }
      }
    }
  }

  if (matchesWithEvents === 0) {
    return {
      matches_played: 0,
      possession_share: 50.0,
      ppda: 12.0,
      build_up_directness: 35.0,
      high_turnovers_per90: 4.0,
      progressive_passes_per90: 30.0,
      box_entries_per90: 12.0,
      xg_per90: 1.2,
    };
  }

  const possShare = roundHalfAway((100.0 * teamPoss) / Math.max(1, totalPoss), 1);
  const ppda = roundHalfAway(oppBuildupPasses / Math.max(1, highDefActions), 2);
  const directness = roundHalfAway((100.0 * longPasses) / Math.max(1, teamPasses), 1);
  const ht90 = roundHalfAway(highTurnovers / matchesWithEvents, 2);
  const prog90 = roundHalfAway(progPasses / matchesWithEvents, 2);
  const box90 = roundHalfAway(boxEntries / matchesWithEvents, 2);
  const xg90 = roundHalfAway(xgFor / matchesWithEvents, 2);

  return {
    matches_played: matchesWithEvents,
    possession_share: possShare,
    ppda,
    build_up_directness: directness,
    high_turnovers_per90: ht90,
    progressive_passes_per90: prog90,
    box_entries_per90: box90,
    xg_per90: xg90,
  };
}

export function runManagerialImpactTracker(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const team = String(cfg.team_name);
  const season = String(cfg.season_name);
  const window = Math.max(2, Math.min(10, Math.trunc(Number(cfg.rolling_window))));
  const grid = String(cfg.coord_grid) as CoordGrid;

  const teamMatches = store.matches
    .filter((m) => m.season_name === season && (m.home_team_name === team || m.away_team_name === team))
    .sort((a, b) => a.match_week - b.match_week);

  const timeline: Array<Record<string, unknown>> = [];
  const milestones: Array<Record<string, unknown>> = [];
  let prevMgr: string | null = null;
  const overrideMw = overrides?.milestone_match_week !== undefined && overrides?.milestone_match_week !== null
    ? Math.trunc(Number(overrides.milestone_match_week))
    : null;

  const teamShots: Array<{ e: EventRow; match_week: number }> = [];

  for (const m of teamMatches) {
    const isHome = m.home_team_name === team;
    const opponent = isHome ? m.away_team_name : m.home_team_name;
    const venue = isHome ? "H" : "A";
    const mgr = String(isHome ? m.home_manager : m.away_manager);
    const formation = isHome ? m.home_formation : m.away_formation;
    const gf = Math.trunc(isHome ? m.home_score : m.away_score);
    const ga = Math.trunc(isHome ? m.away_score : m.home_score);
    const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
    const mw = Math.trunc(m.match_week);

    let xgfRaw = 0;
    let xgaRaw = 0;
    const evs = store.eventsByMatchId.get(m.match_id) || [];
    for (const e of evs) {
      if (e.event_type === "Shot") {
        if (e.team_name === team) {
          xgfRaw += e.xg;
          teamShots.push({ e, match_week: mw });
        } else {
          xgaRaw += e.xg;
        }
      }
    }

    const isChange =
      (prevMgr !== null && mgr !== prevMgr) ||
      (overrideMw !== null && overrideMw === mw && milestones.length === 0);

    if (isChange) {
      milestones.push({
        match_week: mw,
        match_date: m.match_date,
        label: prevMgr && mgr !== prevMgr ? `Manager Shift: ${mgr}` : `Tactical Milestone (MW ${mw})`,
        previous_manager: prevMgr || mgr,
        new_manager: mgr,
      });
    }
    prevMgr = mgr;

    timeline.push({
      match_id: Math.trunc(m.match_id),
      match_week: mw,
      match_date: m.match_date,
      opponent,
      venue,
      manager: mgr,
      formation,
      gf,
      ga,
      pts,
      xgf: roundHalfAway(xgfRaw, 2),
      xga: roundHalfAway(xgaRaw, 2),
    });
  }

  if (milestones.length === 0 && timeline.length > 0) {
    const lastMw = Number(timeline[timeline.length - 1].match_week);
    const splitTarget = Math.min(Math.max(2, Math.trunc(Number(cfg.milestone_match_week))), lastMw);
    const targetRow =
      timeline.find((t) => Number(t.match_week) >= splitTarget) ||
      timeline[Math.floor(timeline.length / 2)];
    milestones.push({
      match_week: targetRow.match_week,
      match_date: targetRow.match_date,
      label: `Tactical Benchmark (MW ${targetRow.match_week})`,
      previous_manager: targetRow.manager,
      new_manager: targetRow.manager,
    });
  }

  for (let i = 0; i < timeline.length; i++) {
    const winSlice = timeline.slice(Math.max(0, i - window + 1), i + 1);
    const wLen = winSlice.length;
    const sumPts = compensatedSum(winSlice.map((x) => Number(x.pts)));
    const sumXgf = compensatedSum(winSlice.map((x) => Number(x.xgf)));
    const sumXga = compensatedSum(winSlice.map((x) => Number(x.xga)));
    timeline[i].rolling_ppg = roundHalfToEven(sumPts / wLen, 2);
    timeline[i].rolling_xgf = roundHalfToEven(sumXgf / wLen, 2);
    timeline[i].rolling_xga = roundHalfToEven(sumXga / wLen, 2);
  }

  const splitMw = milestones.length > 0 ? Number(milestones[0].match_week) : 10;
  const before = timeline.filter((t) => Number(t.match_week) < splitMw);
  const after = timeline.filter((t) => Number(t.match_week) >= splitMw);

  const aggPeriod = (label: string, items: Array<Record<string, unknown>>) => {
    const n = Math.max(1, items.length);
    const ptsSum = compensatedSum(items.map((x) => Number(x.pts)));
    const gfSum = compensatedSum(items.map((x) => Number(x.gf)));
    const gaSum = compensatedSum(items.map((x) => Number(x.ga)));
    const xgfSum = compensatedSum(items.map((x) => Number(x.xgf)));
    const xgaSum = compensatedSum(items.map((x) => Number(x.xga)));
    const xgdSum = compensatedSum(items.map((x) => Number(x.xgf) - Number(x.xga)));
    return {
      period: label,
      matches: items.length,
      ppg: roundHalfToEven(ptsSum / n, 2),
      gf_per90: roundHalfToEven(gfSum / n, 2),
      ga_per90: roundHalfToEven(gaSum / n, 2),
      xgf_per90: roundHalfToEven(xgfSum / n, 2),
      xga_per90: roundHalfToEven(xgaSum / n, 2),
      xg_diff_per90: roundHalfToEven(xgdSum / n, 2),
    };
  };

  const beforeStats = aggPeriod(`Before MW ${splitMw}`, before);
  const afterStats = aggPeriod(`From MW ${splitMw} Onwards`, after);
  const comparisonTable = [beforeStats, afterStats];

  teamShots.sort((a, b) => b.match_week - a.match_week || b.e.xg - a.e.xg);
  const pitchMarkers = teamShots.slice(0, 80).map(({ e, match_week }) => {
    const [px, py] = coordPair(e.x, e.y, e.x_105, e.y_105, grid);
    const isPost = match_week >= splitMw;
    return {
      x: px,
      y: py,
      radius: roundHalfToEven(3.0 + Number(e.xg) * 9.0, 2),
      color: e.outcome === "Goal" ? "#10b981" : isPost ? "#38bdf8" : "#f59e0b",
      label: `${e.player_name} (MW${match_week}, xG ${fmtFixed(Number(e.xg), 2)}, ${e.outcome})`,
      group: isPost ? "Post-Shift" : "Pre-Shift",
    };
  });

  const ppgDelta = roundHalfToEven(afterStats.ppg - beforeStats.ppg, 2);
  const xgdDelta = roundHalfToEven(afterStats.xg_diff_per90 - beforeStats.xg_diff_per90, 2);
  const direction = xgdDelta > 0.05 ? "improving" : xgdDelta < -0.05 ? "declining" : "holding steady";

  let summary: string;
  if (beforeStats.matches === 0 && afterStats.matches === 0) {
    summary = `No match data found for ${team} in ${season}.`;
  } else if (beforeStats.matches === 0 || afterStats.matches === 0) {
    summary =
      `Insufficient split sample for ${team} in ${season} at MW ${splitMw} ` +
      `(${beforeStats.matches} matches before, ${afterStats.matches} from MW ${splitMw} onward).`;
  } else {
    summary =
      `${team} is ${direction} after MW ${splitMw}: rolling xG differential moved by ` +
      `${fmtSigned(xgdDelta, 2)} per match (${fmtSigned(beforeStats.xg_diff_per90, 2)} → ${fmtSigned(afterStats.xg_diff_per90, 2)}) ` +
      `and points per game shifted by ${fmtSigned(ppgDelta, 2)} (${fmtFixed(beforeStats.ppg, 2)} → ${fmtFixed(afterStats.ppg, 2)}).`;
  }

  return {
    module_id: "managerial_impact_tracker",
    title: `Managerial Impact Tracker — ${team} (${season})`,
    coord_grid: grid,
    summary,
    charts: {
      timeline,
      milestones,
      rolling_window: window,
    },
    pitch: {
      title: `${team} Shot Map (Blue = From MW ${splitMw}, Amber = Before MW ${splitMw}, Green = Goals)`,
      markers: pitchMarkers,
      arrows: [],
      zones: [],
    },
    table_columns: ["period", "matches", "ppg", "gf_per90", "ga_per90", "xgf_per90", "xga_per90", "xg_diff_per90"],
    table_rows: comparisonTable,
    assumptions: cfg,
  };
}

export function runTacticalInterventionComparison(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const team = String(cfg.team_name);
  const season = String(cfg.season_name);
  const startMw = Math.trunc(Number(cfg.start_mw));
  const endMw = Math.trunc(Number(cfg.end_mw));
  const grid = String(cfg.coord_grid) as CoordGrid;

  const seasonProfile = computeTeamStyleProfile(store, team, season, cfg);
  const runProfile = computeTeamStyleProfile(store, team, season, cfg, startMw, endMw);

  const allTeams = Array.from(new Set(store.teams.map((t) => t.team_name))).sort();
  const leagueProfiles = allTeams.map((t) => computeTeamStyleProfile(store, t, season, cfg));

  const percentile = (val: number, series: number[], lowerIsBetter = false): number => {
    if (series.length === 0) return 50;
    const rank = series.filter((s) => (lowerIsBetter ? s >= val : s <= val)).length;
    return Math.trunc(roundHalfToEven((100.0 * rank) / series.length, 0));
  };

  const metricsSpec: Array<[keyof TeamStyleProfile, string, boolean]> = [
    ["ppda", "Pressing Intensity (Lower PPDA)", true],
    ["possession_share", "Possession Share (%)", false],
    ["build_up_directness", "Build-up Directness (%)", false],
    ["high_turnovers_per90", "High Turnovers / 90", false],
    ["progressive_passes_per90", "Progressive Passes / 90", false],
    ["box_entries_per90", "Penalty Box Entries / 90", false],
  ];

  const radarData: Array<Record<string, unknown>> = [];
  const tableRows: Array<Record<string, unknown>> = [];

  for (const [key, label, invert] of metricsSpec) {
    const series = leagueProfiles.map((lp) => lp[key]);
    const sVal = seasonProfile[key];
    const rVal = runProfile[key];
    const sPct = percentile(sVal, series, invert);
    const rPct = percentile(rVal, series, invert);
    const delta = roundHalfToEven(rVal - sVal, 2);
    radarData.push({
      metric: label,
      key,
      season_avg: sVal,
      intervention_run: rVal,
      season_percentile: sPct,
      run_percentile: rPct,
      delta,
    });
    tableRows.push({
      metric: label,
      season_avg: sVal,
      intervention_run: rVal,
      delta,
      season_pct: sPct,
      run_pct: rPct,
    });
  }

  const matchedEvs: Array<{ e: EventRow; match_week: number }> = [];
  for (const e of store.events) {
    if (e.team_name !== team) continue;
    if (!e.is_progressive_pass && !e.is_high_turnover) continue;
    const m = store.matchesById.get(e.match_id);
    if (!m || m.season_name !== season) continue;
    if (m.match_week < startMw || m.match_week > endMw) continue;
    matchedEvs.push({ e, match_week: m.match_week });
  }
  matchedEvs.sort((a, b) => b.match_week - a.match_week);

  const arrows: Array<Record<string, unknown>> = [];
  const markers: Array<Record<string, unknown>> = [];
  for (const { e, match_week } of matchedEvs.slice(0, 60)) {
    const [px, py] = coordPair(e.x, e.y, e.x_105, e.y_105, grid);
    if (e.event_type === "Pass" && e.end_x !== null && e.end_y !== null) {
      const [ex, ey] = coordPair(e.end_x, e.end_y, e.end_x_105 ?? e.x_105, e.end_y_105 ?? e.y_105, grid);
      arrows.push({
        x1: px,
        y1: py,
        x2: ex,
        y2: ey,
        color: "#38bdf8",
        label: `Prog Pass: ${e.player_name} (MW${match_week})`,
      });
    } else {
      markers.push({
        x: px,
        y: py,
        radius: 4.2,
        color: "#f43f5e",
        label: `High Turnover: ${e.player_name} (MW${match_week})`,
        group: "High Turnover",
      });
    }
  }

  const interventionSummary =
    runProfile.matches_played === 0 || seasonProfile.matches_played === 0
      ? `Insufficient match data for ${team} during MW ${startMw}–${endMw} in ${season} ` +
        `(${runProfile.matches_played} matches in window, ${seasonProfile.matches_played} in season).`
      : `During MW ${startMw}–${endMw} (${runProfile.matches_played} matches), ${team} recorded PPDA of ` +
        `${fmtFixed(runProfile.ppda, 2)} (season avg ${fmtFixed(seasonProfile.ppda, 2)}), ${fmtFixed(runProfile.possession_share, 1)}% possession ` +
        `(season ${fmtFixed(seasonProfile.possession_share, 1)}%), and ${fmtFixed(runProfile.progressive_passes_per90, 1)} progressive passes/90.`;

  return {
    module_id: "tactical_intervention_comparison",
    title: `Tactical Intervention Comparison — ${team} (MW ${startMw}–${endMw} vs Season Avg)`,
    coord_grid: grid,
    summary: interventionSummary,
    charts: {
      radar: radarData,
      match_window: {
        start_mw: startMw,
        end_mw: endMw,
        matches: runProfile.matches_played,
        season_matches: seasonProfile.matches_played,
      },
    },
    pitch: {
      title: `${team} Progressive Passes (Blue Arrows) & High Turnovers (Red Dots) in MW ${startMw}–${endMw}`,
      arrows: arrows.slice(0, 35),
      markers: markers.slice(0, 35),
      zones: [],
    },
    table_columns: ["metric", "season_avg", "intervention_run", "delta", "season_pct", "run_pct"],
    table_rows: tableRows,
    assumptions: cfg,
  };
}

export function runOppositionScoutingOnePager(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const opp = String(cfg.opponent_name);
  const season = String(cfg.season_name);
  const grid = String(cfg.coord_grid) as CoordGrid;

  const oppStyle = computeTeamStyleProfile(store, opp, season, cfg);

  const stateBuckets = new Map<
    string,
    {
      shapeCounts: Map<string, number>;
      events: number;
      passCount: number;
      highPassCount: number;
      progPassCount: number;
      defLineSum: number;
      defLineCount: number;
    }
  >();

  const pressOrder = [
    ["Low Block", "Left Wing"],
    ["Low Block", "Central Corridor"],
    ["Low Block", "Right Wing"],
    ["Mid Block", "Left Wing"],
    ["Mid Block", "Central Corridor"],
    ["Mid Block", "Right Wing"],
    ["High Press", "Left Wing"],
    ["High Press", "Central Corridor"],
    ["High Press", "Right Wing"],
  ] as const;

  const pressMap = new Map<string, { third: string; lane: string; count: number; turnovers: number }>();
  const threatMap = new Map<string, { player_name: string; position: string; xg: number; kp: number; prog: number }>();

  const seasonMatches = new Map<number, MatchRow>();
  for (const m of store.matches) {
    if (m.season_name === season) seasonMatches.set(m.match_id, m);
  }

  for (const e of store.events) {
    if (e.team_name !== opp) continue;
    if (!seasonMatches.has(e.match_id)) continue;

    // Match state bucket
    const st = e.match_state;
    let bucket = stateBuckets.get(st);
    if (!bucket) {
      bucket = {
        shapeCounts: new Map(),
        events: 0,
        passCount: 0,
        highPassCount: 0,
        progPassCount: 0,
        defLineSum: 0,
        defLineCount: 0,
      };
      stateBuckets.set(st, bucket);
    }
    bucket.events += 1;
    if (e.tactical_formation !== null && e.tactical_formation !== undefined) {
      bucket.shapeCounts.set(e.tactical_formation, (bucket.shapeCounts.get(e.tactical_formation) || 0) + 1);
    }
    if (e.event_type === "Pass") {
      bucket.passCount += 1;
      if (e.pass_height === "High Pass") bucket.highPassCount += 1;
    }
    if (e.is_progressive_pass) bucket.progPassCount += 1;
    if (e.is_defensive_action) {
      bucket.defLineSum += e.x_105;
      bucket.defLineCount += 1;

      const third = e.x_105 < 35 ? "Low Block" : e.x_105 < 70 ? "Mid Block" : "High Press";
      const lane = e.y_105 < 22.6 ? "Left Wing" : e.y_105 <= 45.4 ? "Central Corridor" : "Right Wing";
      const pk = `${third}|${lane}`;
      let pRec = pressMap.get(pk);
      if (!pRec) {
        pRec = { third, lane, count: 0, turnovers: 0 };
        pressMap.set(pk, pRec);
      }
      pRec.count += 1;
      if (e.is_high_turnover) pRec.turnovers += 1;
    }

    if (e.player_name !== null && e.player_name !== undefined) {
      const pos = e.position_name ?? "";
      const tk = `${e.player_name}\u0000${pos}`;
      let tRec = threatMap.get(tk);
      if (!tRec) {
        tRec = { player_name: e.player_name, position: pos, xg: 0, kp: 0, prog: 0 };
        threatMap.set(tk, tRec);
      }
      if (e.event_type === "Shot") tRec.xg += e.xg;
      if (e.is_key_pass) tRec.kp += 1;
      if (e.is_progressive_pass || e.is_progressive_carry) tRec.prog += 1;
    }
  }

  const stateOrder: Record<string, number> = { winning: 1, drawing: 2 };
  const sortedStates = Array.from(stateBuckets.entries()).sort(
    (a, b) => (stateOrder[a[0]] ?? 3) - (stateOrder[b[0]] ?? 3)
  );

  const titleCase = (s: string) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  const tableRows = sortedStates.map(([st, b]) => {
    const shapes = Array.from(b.shapeCounts.entries()).sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]));
    const primaryShape = shapes.length ? shapes[0][0] : "None";
    const directPct = roundHalfAway((100.0 * b.highPassCount) / Math.max(1, b.passCount), 1);
    const progShare = roundHalfAway((100.0 * b.progPassCount) / Math.max(1, b.passCount), 1);
    const avgDef = b.defLineCount > 0 ? roundHalfAway(b.defLineSum / b.defLineCount, 1) : null;
    return {
      match_state: titleCase(st),
      primary_shape: String(primaryShape),
      events: b.events,
      directness_pct: directPct,
      prog_pass_share: progShare,
      avg_def_line_m: avgDef,
    };
  });

  const pressRows = pressOrder
    .map(([third, lane]) => pressMap.get(`${third}|${lane}`))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const maxPress = Math.max(1, ...pressRows.map((r) => r.count));
  const xBounds: Record<string, [number, number]> = {
    "Low Block": grid === "120x80" ? [0.0, 40.0] : [0.0, 35.0],
    "Mid Block": grid === "120x80" ? [40.0, 80.0] : [35.0, 70.0],
    "High Press": grid === "120x80" ? [80.0, 120.0] : [70.0, 105.0],
  };
  const yBounds: Record<string, [number, number]> = {
    "Left Wing": grid === "120x80" ? [0.0, 26.7] : [0.0, 22.6],
    "Central Corridor": grid === "120x80" ? [26.7, 53.3] : [22.6, 45.4],
    "Right Wing": grid === "120x80" ? [53.3, 80.0] : [45.4, 68.0],
  };

  const zones = pressRows.map((pr) => {
    const [x0, x1] = xBounds[pr.third];
    const [y0, y1] = yBounds[pr.lane];
    return {
      zone_id: `${pr.third} - ${pr.lane}`,
      x: x0,
      y: y0,
      width: roundHalfToEven(x1 - x0, 2),
      height: roundHalfToEven(y1 - y0, 2),
      intensity: roundHalfToEven(pr.count / maxPress, 3),
      value_label: `${pr.count}`,
      tooltip: `${pr.third} (${pr.lane}): ${pr.count} defensive triggers, ${pr.turnovers} turnovers`,
    };
  });

  const dangerPlayers = Array.from(threatMap.values())
    .map((t) => {
      const totalXg = roundHalfAway(t.xg, 2);
      return {
        player_name: t.player_name,
        position: t.position,
        total_xg: totalXg,
        key_passes: t.kp,
        prog_actions: t.prog,
        _score: totalXg * 10 + t.kp * 2 + t.prog * 0.25,
      };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 4)
    .map(({ _score, ...rest }) => rest);

  const formCounts = new Map<string, number>();
  for (const m of seasonMatches.values()) {
    if (m.home_team_name === opp) formCounts.set(m.home_formation, (formCounts.get(m.home_formation) || 0) + 1);
    if (m.away_team_name === opp) formCounts.set(m.away_formation, (formCounts.get(m.away_formation) || 0) + 1);
  }
  const formationsUsed = Array.from(formCounts.entries())
    .map(([formation, matches]) => ({ formation, matches }))
    .sort((a, b) => b.matches - a.matches);

  const oppSummary =
    oppStyle.matches_played === 0
      ? `No match data found for ${opp} in ${season}.`
      : `Pre-Match Briefing on ${opp}: PPDA ${fmtFixed(oppStyle.ppda, 2)}, ${fmtFixed(oppStyle.possession_share, 1)}% possession, ` +
        `${fmtFixed(oppStyle.build_up_directness, 1)}% long build-up share, primary shape ${formationsUsed.length ? formationsUsed[0].formation : "unknown"}. ` +
        `Key threat: ${dangerPlayers.length ? dangerPlayers[0].player_name : "N/A"}.`;

  return {
    module_id: "opposition_scouting_one_pager",
    title: `Opposition Scouting One-Pager — ${opp} (${season})`,
    coord_grid: grid,
    summary: oppSummary,
    charts: {
      style_kpis: oppStyle,
      formations: formationsUsed,
      danger_players: dangerPlayers,
    },
    pitch: {
      title: `${opp} Pressing Intensity & Defensive Trigger Zones (Attacking Left → Right)`,
      zones,
      markers: [],
      arrows: [],
    },
    table_columns: ["match_state", "primary_shape", "events", "directness_pct", "prog_pass_share", "avg_def_line_m"],
    table_rows: tableRows,
    assumptions: cfg,
  };
}

export function runMultiSeasonPlayerProgression(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const s1 = String(cfg.season_1);
  const s2 = String(cfg.season_2);
  const minMins = Math.trunc(Number(cfg.min_minutes));
  const norm = String(cfg.normalisation);
  const composite = String(cfg.skill_composite);
  const grid = String(cfg.coord_grid) as CoordGrid;

  const targetSeasons = new Set([s1, s2]);
  const relevantMatches = new Map<number, MatchRow>();
  for (const m of store.matches) {
    if (targetSeasons.has(m.season_name)) relevantMatches.set(m.match_id, m);
  }

  // player_mins grouped by (season_name, player_id, player_name)
  const pmMap = new Map<
    string,
    { season_name: string; player_id: number; player_name: string; team_name: string; position_name: string; minutes_played: number }
  >();
  // distinct (match_id, team_name) from lineups
  const matchTeams = new Map<number, Set<string>>();

  for (const l of store.lineups) {
    const m = relevantMatches.get(l.match_id);
    if (!m) continue;
    let mtSet = matchTeams.get(l.match_id);
    if (!mtSet) {
      mtSet = new Set();
      matchTeams.set(l.match_id, mtSet);
    }
    mtSet.add(l.team_name);

    const k = `${m.season_name}\u0000${l.player_id}\u0000${l.player_name}`;
    let rec = pmMap.get(k);
    if (!rec) {
      rec = {
        season_name: m.season_name,
        player_id: l.player_id,
        player_name: l.player_name,
        team_name: l.team_name,
        position_name: l.position_name,
        minutes_played: 0,
      };
      pmMap.set(k, rec);
    } else {
      if (l.team_name > rec.team_name) rec.team_name = l.team_name;
      if (l.position_name > rec.position_name) rec.position_name = l.position_name;
    }
    rec.minutes_played += l.minutes_played;
  }

  // team_poss per (season_name, team_name)
  const teamPossMap = new Map<string, { total: number; owned: number }>();
  for (const [mid, m] of relevantMatches.entries()) {
    const teamsInMatch = matchTeams.get(mid);
    if (!teamsInMatch || teamsInMatch.size === 0) continue;
    const evs = store.eventsByMatchId.get(mid) || [];
    const distinctPoss = new Map<number, string>();
    for (const e of evs) {
      if (!distinctPoss.has(e.possession)) {
        distinctPoss.set(e.possession, e.possession_team_name);
      }
    }
    for (const tName of teamsInMatch) {
      const k = `${m.season_name}\u0000${tName}`;
      let tp = teamPossMap.get(k);
      if (!tp) {
        tp = { total: 0, owned: 0 };
        teamPossMap.set(k, tp);
      }
      for (const pTeam of distinctPoss.values()) {
        tp.total += 1;
        if (pTeam === tName) tp.owned += 1;
      }
    }
  }

  // player_events grouped by (season_name, player_id)
  const peMap = new Map<
    string,
    {
      prog_passes: number;
      prog_carries: number;
      box_entries: number;
      xg: number;
      shots: number;
      key_passes: number;
      assists: number;
      def_actions: number;
      high_turnovers: number;
    }
  >();

  for (const e of store.events) {
    if (e.player_id === null || e.player_id === undefined) continue;
    const m = relevantMatches.get(e.match_id);
    if (!m) continue;
    const k = `${m.season_name}\u0000${e.player_id}`;
    let pe = peMap.get(k);
    if (!pe) {
      pe = {
        prog_passes: 0,
        prog_carries: 0,
        box_entries: 0,
        xg: 0,
        shots: 0,
        key_passes: 0,
        assists: 0,
        def_actions: 0,
        high_turnovers: 0,
      };
      peMap.set(k, pe);
    }
    if (e.is_progressive_pass) pe.prog_passes += 1;
    if (e.is_progressive_carry) pe.prog_carries += 1;
    if (e.is_box_entry) pe.box_entries += 1;
    if (e.event_type === "Shot") {
      pe.xg += e.xg;
      pe.shots += 1;
    }
    if (e.is_key_pass) pe.key_passes += 1;
    if (e.is_assist) pe.assists += 1;
    if (e.is_defensive_action) pe.def_actions += 1;
    if (e.is_high_turnover) pe.high_turnovers += 1;
  }

  const byPlayer = new Map<
    number,
    {
      player_id: number;
      player_name: string;
      team_name: string;
      position: string;
      s1_score?: number;
      season_1_minutes?: number;
      s2_score?: number;
      season_2_minutes?: number;
    }
  >();

  for (const pm of pmMap.values()) {
    if (pm.minutes_played < minMins) continue;
    const tp = teamPossMap.get(`${pm.season_name}\u0000${pm.team_name}`);
    const poss = tp ? (100.0 * tp.owned) / Math.max(1, tp.total) : 50.0;
    const pe = peMap.get(`${pm.season_name}\u0000${pm.player_id}`) || {
      prog_passes: 0,
      prog_carries: 0,
      box_entries: 0,
      xg: 0,
      shots: 0,
      key_passes: 0,
      assists: 0,
      def_actions: 0,
      high_turnovers: 0,
    };

    const mins = Math.max(1.0, pm.minutes_played);
    const padjFactor = norm === "possession_adjusted" ? 50.0 / Math.max(20.0, 100.0 - poss) : 1.0;
    const scale90 = 90.0 / mins;

    const progP90 = pe.prog_passes * scale90;
    const carryP90 = pe.prog_carries * scale90;
    const boxP90 = pe.box_entries * scale90;
    const xg90 = pe.xg * scale90;
    const shots90 = pe.shots * scale90;
    const kp90 = pe.key_passes * scale90;
    const ast90 = pe.assists * scale90;
    const def90 = pe.def_actions * scale90 * padjFactor;
    const ht90 = pe.high_turnovers * scale90 * padjFactor;

    let val: number;
    if (composite === "box_threat") {
      val = xg90 * 12.0 + shots90 * 1.4 + boxP90 * 0.65;
    } else if (composite === "defensive_disruption") {
      val = def90 * 0.8 + ht90 * 2.5;
    } else if (composite === "chance_creation") {
      val = kp90 * 2.5 + ast90 * 5.0 + boxP90 * 0.5;
    } else {
      val = progP90 * 0.9 + carryP90 * 0.7 + boxP90 * 0.8;
    }

    const score = roundHalfToEven(val, 2);
    const pid = Math.trunc(pm.player_id);
    let entry = byPlayer.get(pid);
    if (!entry) {
      entry = {
        player_id: pid,
        player_name: pm.player_name,
        team_name: pm.team_name,
        position: pm.position_name,
      };
      byPlayer.set(pid, entry);
    }
    if (pm.season_name === s1) {
      entry.s1_score = score;
      entry.season_1_minutes = Math.trunc(pm.minutes_played);
    } else if (pm.season_name === s2) {
      entry.s2_score = score;
      entry.season_2_minutes = Math.trunc(pm.minutes_played);
    }
  }

  const ranked: Array<{
    player_id: number;
    player_name: string;
    team_name: string;
    position: string;
    season_1_minutes: number;
    season_2_minutes: number;
    season_1_score: number;
    season_2_score: number;
    delta: number;
    pct_change: number;
  }> = [];

  for (const item of byPlayer.values()) {
    if (item.s1_score !== undefined && item.s2_score !== undefined) {
      const delta = roundHalfToEven(item.s2_score - item.s1_score, 2);
      const pctChange = roundHalfToEven((100.0 * delta) / Math.max(0.2, item.s1_score), 1);
      ranked.push({
        player_id: item.player_id,
        player_name: item.player_name,
        team_name: item.team_name,
        position: item.position,
        season_1_minutes: item.season_1_minutes!,
        season_2_minutes: item.season_2_minutes!,
        season_1_score: item.s1_score,
        season_2_score: item.s2_score,
        delta,
        pct_change: pctChange,
      });
    }
  }

  ranked.sort((a, b) => b.delta - a.delta);
  const topPlayers = ranked.slice(0, 15);
  const topPlayerName = topPlayers.length > 0 ? topPlayers[0].player_name : "";

  const markers: Array<Record<string, unknown>> = [];
  const arrows: Array<Record<string, unknown>> = [];
  if (topPlayerName) {
    let count = 0;
    for (const e of store.events) {
      if (count >= 50) break;
      if (e.player_name !== topPlayerName) continue;
      if (!e.is_progressive_pass && e.event_type !== "Shot") continue;
      const m = store.matchesById.get(e.match_id);
      if (!m || m.season_name !== s2) continue;
      count += 1;

      const [px, py] = coordPair(e.x, e.y, e.x_105, e.y_105, grid);
      if (e.event_type === "Pass" && e.end_x !== null && e.end_y !== null) {
        const [ex, ey] = coordPair(e.end_x, e.end_y, e.end_x_105 ?? e.x_105, e.end_y_105 ?? e.y_105, grid);
        arrows.push({ x1: px, y1: py, x2: ex, y2: ey, color: "#a855f7", label: `${topPlayerName} Prog Pass` });
      } else if (e.event_type === "Shot") {
        markers.push({
          x: px,
          y: py,
          radius: roundHalfToEven(3.0 + Number(e.xg) * 8.0, 2),
          color: e.outcome === "Goal" ? "#10b981" : "#f59e0b",
          label: `${topPlayerName} Shot (xG ${fmtFixed(Number(e.xg), 2)})`,
          group: e.outcome,
        });
      }
    }
  }

  const scoutingSummary =
    topPlayers.length > 0
      ? `Across ${ranked.length} qualifying players (>= ${minMins} mins in both ${s1} & ${s2}, ${norm} normalization), ` +
        `${topPlayers[0].player_name} (${topPlayers[0].team_name}) led ${composite.replace(/_/g, " ")} progression ` +
        `with a ${fmtSigned(topPlayers[0].delta, 2)} composite jump (${fmtFixed(topPlayers[0].season_1_score, 2)} → ${fmtFixed(topPlayers[0].season_2_score, 2)}).`
      : `No players met the ${minMins} minute threshold in both ${s1} and ${s2}.`;

  const compTitle = composite
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    module_id: "multi_season_player_progression",
    title: `Multi-Season Player Progression (${compTitle}: ${s1} → ${s2})`,
    coord_grid: grid,
    summary: scoutingSummary,
    charts: {
      leaderboard: topPlayers.slice(0, 10),
      composite,
      normalisation: norm,
      total_qualifiers: ranked.length,
    },
    pitch: {
      title: `Top Improver Action Map (${topPlayerName || "N/A"} — ${s2})`,
      arrows: arrows.slice(0, 30),
      markers: markers.slice(0, 30),
      zones: [],
    },
    table_columns: [
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
    table_rows: topPlayers,
    assumptions: cfg,
  };
}

export function runTacticalFitRecruitmentMatcher(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const playerName = String(cfg.player_name);
  const targetClub = String(cfg.target_club);
  const season = String(cfg.season_name);
  const grid = String(cfg.coord_grid) as CoordGrid;

  const qLower = playerName.toLowerCase();
  const matchedRow = store.players.find((p) => p.player_name.toLowerCase().includes(qLower));
  const playerMatched = matchedRow !== undefined;
  const pRow = matchedRow ?? store.players[0];

  const resolvedPlayer = pRow ? String(pRow.player_name) : playerName;
  const currentClub = pRow ? String(pRow.team_name) : String(cfg.team_name);
  const playerPos = pRow ? String(pRow.primary_position) : "";

  const currentStyle = computeTeamStyleProfile(store, currentClub, season, cfg);
  const targetStyle = computeTeamStyleProfile(store, targetClub, season, cfg);

  const dims: Array<[keyof TeamStyleProfile, string, number]> = [
    ["ppda", "Pressing Intensity (PPDA)", 20.0],
    ["possession_share", "Possession Share (%)", 40.0],
    ["build_up_directness", "Build-up Directness (%)", 35.0],
    ["high_turnovers_per90", "High Turnovers / 90", 6.0],
    ["progressive_passes_per90", "Progressive Passes / 90", 30.0],
    ["box_entries_per90", "Box Entries / 90", 15.0],
  ];

  const radarData: Array<Record<string, unknown>> = [];
  const tableRows: Array<Record<string, unknown>> = [];
  const diffs: number[] = [];
  const risks: string[] = [];

  for (const [key, label, scale] of dims) {
    const cVal = currentStyle[key];
    const tVal = targetStyle[key];
    const gap = roundHalfToEven(tVal - cVal, 2);
    const normDiff = Math.min(1.0, Math.abs(gap) / scale);
    const overlapPct = Math.trunc(roundHalfToEven((1.0 - normDiff) * 100, 0));
    diffs.push(normDiff);
    radarData.push({
      metric: label,
      current_club_val: cVal,
      target_club_val: tVal,
      overlap_pct: overlapPct,
    });
    const riskFlag =
      overlapPct < 68
        ? "High Adaptation Gap"
        : overlapPct < 85
          ? "Moderate Adjustment"
          : "Strong Alignment";
    tableRows.push({
      dimension: label,
      player_team_val: cVal,
      target_club_val: tVal,
      delta: gap,
      overlap_pct: overlapPct,
      status: riskFlag,
    });
    if (overlapPct < 78) {
      risks.push(`${label}: ${currentClub} averages ${cVal} vs ${targetClub} at ${tVal} (${overlapPct}% overlap).`);
    }
  }

  const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const fitScore = Math.trunc(roundHalfToEven(Math.max(25.0, Math.min(99.0, 100.0 * (1.0 - meanDiff))), 0));
  if (risks.length === 0) {
    risks.push(
      `Minimal tactical friction: ${currentClub} and ${targetClub} operate within 15% across all 6 style metrics.`
    );
  }

  const markers: Array<Record<string, unknown>> = [];
  const arrows: Array<Record<string, unknown>> = [];
  let evScanned = 0;
  for (const e of store.events) {
    if (evScanned >= 80) break;
    if (e.player_name !== resolvedPlayer) continue;
    const m = store.matchesById.get(e.match_id);
    if (!m || m.season_name !== season) continue;
    evScanned += 1;

    const [px, py] = coordPair(e.x, e.y, e.x_105, e.y_105, grid);
    if (e.event_type === "Pass" && e.end_x !== null && e.end_y !== null && arrows.length < 25) {
      const [ex, ey] = coordPair(e.end_x, e.end_y, e.end_x_105 ?? e.x_105, e.end_y_105 ?? e.y_105, grid);
      arrows.push({ x1: px, y1: py, x2: ex, y2: ey, color: "#22d3ee", label: `${resolvedPlayer} Pass` });
    } else if (markers.length < 35) {
      markers.push({
        x: px,
        y: py,
        radius: 3.5,
        color: e.event_type === "Shot" ? "#10b981" : "#94a3b8",
        label: `${resolvedPlayer} ${e.event_type}`,
        group: e.event_type,
      });
    }
  }

  let fitSummary: string;
  if (!playerMatched) {
    fitSummary = `Player '${playerName}' was not found in the squad catalog for ${season}.`;
  } else if (currentStyle.matches_played === 0 || targetStyle.matches_played === 0) {
    fitSummary =
      `Insufficient match data in ${season} to compare ${resolvedPlayer} ` +
      `(${currentClub}, ${currentStyle.matches_played} matches) with ${targetClub} (${targetStyle.matches_played} matches).`;
  } else {
    fitSummary =
      `${resolvedPlayer} (${playerPos}, ${currentClub}) achieves a ${fitScore}% Tactical Fit Score for ${targetClub}. ` +
      risks[0];
  }

  return {
    module_id: "tactical_fit_recruitment_matcher",
    title: `Tactical Fit Matcher — ${resolvedPlayer} (${currentClub}) → ${targetClub}`,
    coord_grid: grid,
    summary: fitSummary,
    charts: {
      fit_score: fitScore,
      player_name: resolvedPlayer,
      requested_player: playerName,
      player_matched: playerMatched,
      current_club: currentClub,
      target_club: targetClub,
      current_club_matches: currentStyle.matches_played,
      target_club_matches: targetStyle.matches_played,
      radar: radarData,
      adaptation_risks: risks,
    },
    pitch: {
      title: `${resolvedPlayer} On-Ball Footprint & Passing Vectors (${season})`,
      markers,
      arrows,
      zones: [],
    },
    table_columns: ["dimension", "player_team_val", "target_club_val", "delta", "overlap_pct", "status"],
    table_rows: tableRows,
    assumptions: cfg,
  };
}

function simulateMatchXpts(homeShots: number[], awayShots: number[]): [number, number] {
  const goalDist = (xgs: number[]): number[] => {
    let dist = [1.0];
    for (const p of xgs) {
      const pc = Math.max(0.0, Math.min(0.99, Number(p)));
      const nxt = new Array<number>(dist.length + 1).fill(0.0);
      for (let k = 0; k < dist.length; k++) {
        const prob = dist[k];
        nxt[k] += prob * (1.0 - pc);
        nxt[k + 1] += prob * pc;
      }
      dist = nxt;
    }
    return dist;
  };

  const hd = goalDist(homeShots);
  const ad = goalDist(awayShots);
  let pHw = 0.0;
  let pDr = 0.0;
  let pAw = 0.0;
  for (let hg = 0; hg < hd.length; hg++) {
    const hp = hd[hg];
    for (let ag = 0; ag < ad.length; ag++) {
      const prob = hp * ad[ag];
      if (hg > ag) pHw += prob;
      else if (hg === ag) pDr += prob;
      else pAw += prob;
    }
  }
  return [3.0 * pHw + pDr, 3.0 * pAw + pDr];
}

export function runLeagueTableVsUnderlyingPlay(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const season = String(cfg.season_name);
  const grid = String(cfg.coord_grid) as CoordGrid;

  const matches = store.matches
    .filter((m) => m.season_name === season)
    .sort((a, b) => a.match_id - b.match_id);

  const shotMap = new Map<string, number[]>();
  for (const m of matches) {
    const evs = store.eventsByMatchId.get(m.match_id) || [];
    for (const e of evs) {
      if (e.event_type !== "Shot") continue;
      const k = `${m.match_id}\u0000${e.team_name}`;
      let arr = shotMap.get(k);
      if (!arr) {
        arr = [];
        shotMap.set(k, arr);
      }
      arr.push(e.xg);
    }
  }

  const standings = new Map<
    string,
    { team_name: string; mp: number; actual_pts: number; gf: number; ga: number; xgf: number; xga: number; xpts: number }
  >();

  for (const m of matches) {
    const mid = Math.trunc(m.match_id);
    const hs = Math.trunc(m.home_score);
    const as_ = Math.trunc(m.away_score);
    const hShots = shotMap.get(`${mid}\u0000${m.home_team_name}`) || [];
    const aShots = shotMap.get(`${mid}\u0000${m.away_team_name}`) || [];
    const [hxpts, axpts] = simulateMatchXpts(hShots, aShots);

    const sides: Array<[string, number, number, number[], number[], number]> = [
      [m.home_team_name, hs, as_, hShots, aShots, hxpts],
      [m.away_team_name, as_, hs, aShots, hShots, axpts],
    ];
    for (const [name, gf, ga, xgList, xgaList, xpts] of sides) {
      let rec = standings.get(name);
      if (!rec) {
        rec = { team_name: name, mp: 0, actual_pts: 0, gf: 0, ga: 0, xgf: 0.0, xga: 0.0, xpts: 0.0 };
        standings.set(name, rec);
      }
      rec.mp += 1;
      rec.gf += gf;
      rec.ga += ga;
      rec.actual_pts += gf > ga ? 3 : gf === ga ? 1 : 0;
      for (const x of xgList) rec.xgf += x;
      for (const x of xgaList) rec.xga += x;
      rec.xpts += xpts;
    }
  }

  const tableRows: Array<Record<string, unknown>> = [];
  for (const rec of standings.values()) {
    const xgf = roundHalfToEven(rec.xgf, 2);
    const xga = roundHalfToEven(rec.xga, 2);
    const xpts = roundHalfToEven(rec.xpts, 1);
    const ptsDiff = roundHalfToEven(rec.actual_pts - xpts, 1);
    const gd = rec.gf - rec.ga;
    const xgd = roundHalfToEven(xgf - xga, 2);
    const flag = ptsDiff >= 3.0 ? "Overperforming" : ptsDiff <= -3.0 ? "Underperforming" : "On Par";
    tableRows.push({
      team_name: rec.team_name,
      mp: rec.mp,
      actual_pts: rec.actual_pts,
      xpts,
      pts_residual: ptsDiff,
      gf: rec.gf,
      ga: rec.ga,
      gd,
      xgf,
      xga,
      xgd,
      status: flag,
    });
  }

  tableRows.sort((a, b) => Number(b.actual_pts) - Number(a.actual_pts) || Number(b.gd) - Number(a.gd));
  tableRows.forEach((r, idx) => {
    r.actual_rank = idx + 1;
  });

  const xptsSorted = [...tableRows].sort((a, b) => Number(b.xpts) - Number(a.xpts) || Number(b.xgd) - Number(a.xgd));
  xptsSorted.forEach((r, idx) => {
    r.xpts_rank = idx + 1;
  });

  let overperf = tableRows[0] ?? null;
  let underperf = tableRows[0] ?? null;
  for (const r of tableRows) {
    if (overperf && Number(r.pts_residual) > Number(overperf.pts_residual)) overperf = r;
    if (underperf && Number(r.pts_residual) < Number(underperf.pts_residual)) underperf = r;
  }

  return {
    module_id: "league_table_vs_underlying_play",
    title: `League Table vs Underlying Play (Simulated xPTS — ${season})`,
    coord_grid: grid,
    summary:
      overperf && underperf
        ? `Shot-level Poisson xPTS model across ${matches.length} matches (${season}): ` +
          `${overperf.team_name} leads overperformers (${fmtSigned(Number(overperf.pts_residual), 1)} pts vs xPTS) while ` +
          `${underperf.team_name} is the biggest underperformer (${fmtSigned(Number(underperf.pts_residual), 1)} pts vs xPTS).`
        : `No match data found in ${season} to compute league table vs expected points.`,
    charts: {
      scatter: tableRows,
    },
    pitch: {
      title: `League Shot Quality Landscape (${season})`,
      markers: [],
      arrows: [],
      zones: [],
    },
    table_columns: [
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
    table_rows: tableRows,
    assumptions: cfg,
  };
}

function classifyShotZone120(x: number, y: number): string {
  if (x >= 114.0 && y >= 30.0 && y <= 50.0) return "Six-Yard Box";
  if (x >= 102.0 && y >= 30.0 && y <= 50.0) return "Central Penalty Area";
  if (x >= 102.0 && y >= 18.0 && y < 30.0) return "Left Box Channel";
  if (x >= 102.0 && y > 50.0 && y <= 62.0) return "Right Box Channel";
  if (x >= 93.0 && x < 102.0 && y >= 30.0 && y <= 50.0) return "Box Edge (Zone 14)";
  if (x >= 93.0 && x < 102.0 && y >= 18.0 && y < 30.0) return "Left Half-Space";
  if (x >= 93.0 && x < 102.0 && y > 50.0 && y <= 62.0) return "Right Half-Space";
  if (y < 18.0) return "Wide Left Wing";
  if (y > 62.0) return "Wide Right Wing";
  return "Long Range Central";
}

function zoneGeometry(zoneName: string, grid: CoordGrid): [number, number, number, number] {
  const boxes120: Record<string, [number, number, number, number]> = {
    "Six-Yard Box": [114.0, 30.0, 6.0, 20.0],
    "Central Penalty Area": [102.0, 30.0, 12.0, 20.0],
    "Left Box Channel": [102.0, 18.0, 12.0, 12.0],
    "Right Box Channel": [102.0, 50.0, 12.0, 12.0],
    "Box Edge (Zone 14)": [93.0, 30.0, 9.0, 20.0],
    "Left Half-Space": [93.0, 18.0, 9.0, 12.0],
    "Right Half-Space": [93.0, 50.0, 9.0, 12.0],
    "Wide Left Wing": [80.0, 0.0, 40.0, 18.0],
    "Wide Right Wing": [80.0, 62.0, 40.0, 18.0],
    "Long Range Central": [80.0, 18.0, 13.0, 44.0],
  };
  const [x, y, w, h] = boxes120[zoneName];
  if (grid === "105x68") {
    const sx = 105.0 / 120.0;
    const sy = 68.0 / 80.0;
    return [
      roundHalfToEven(x * sx, 2),
      roundHalfToEven(y * sy, 2),
      roundHalfToEven(w * sx, 2),
      roundHalfToEven(h * sy, 2),
    ];
  }
  return [x, y, w, h];
}

export function runShotLocationZoneEfficiency(
  store: DatasetStore,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  const cfg = mergeAssumptions(overrides);
  const team = String(cfg.team_name);
  const season = String(cfg.season_name);
  const grid = String(cfg.coord_grid) as CoordGrid;

  const zoneOrder = [
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
  ];

  const teamAcc: Record<string, { shots: number; goals: number; xg: number }> = {};
  const lgAcc: Record<string, { shots: number; goals: number; xg: number }> = {};
  for (const z of zoneOrder) {
    teamAcc[z] = { shots: 0, goals: 0, xg: 0.0 };
    lgAcc[z] = { shots: 0, goals: 0, xg: 0.0 };
  }

  const pitchMarkers: Array<Record<string, unknown>> = [];
  let teamTotalShots = 0;
  let lgTotalShots = 0;

  for (const e of store.events) {
    if (e.event_type !== "Shot") continue;
    const m = store.matchesById.get(e.match_id);
    if (!m || m.season_name !== season) continue;

    lgTotalShots += 1;
    const z = classifyShotZone120(Number(e.x), Number(e.y));
    const isGoal = e.outcome === "Goal" ? 1 : 0;
    lgAcc[z].shots += 1;
    lgAcc[z].goals += isGoal;
    lgAcc[z].xg += Number(e.xg);

    if (e.team_name === team) {
      teamTotalShots += 1;
      teamAcc[z].shots += 1;
      teamAcc[z].goals += isGoal;
      teamAcc[z].xg += Number(e.xg);
      const [px, py] = coordPair(Number(e.x), Number(e.y), Number(e.x_105), Number(e.y_105), grid);
      pitchMarkers.push({
        x: px,
        y: py,
        radius: roundHalfToEven(2.8 + Number(e.xg) * 9.0, 2),
        color: isGoal ? "#10b981" : "#38bdf8",
        label: `${e.player_name} (${e.minute}'): xG ${fmtFixed(Number(e.xg), 2)} [${e.outcome}] — ${z}`,
        group: isGoal ? "Goal" : "Non-Goal Shot",
      });
    }
  }

  const tableRows: Array<Record<string, unknown>> = [];
  const zones: Array<Record<string, unknown>> = [];
  const maxZShots = Math.max(1, ...Object.values(teamAcc).map((v) => v.shots));

  for (const z of zoneOrder) {
    const tS = teamAcc[z].shots;
    const tG = teamAcc[z].goals;
    const tXg = roundHalfToEven(teamAcc[z].xg, 2);
    const tXgShot = tS ? roundHalfToEven(tXg / Math.max(1, tS), 3) : 0.0;
    const tConv = tS ? roundHalfToEven((100.0 * tG) / Math.max(1, tS), 1) : 0.0;
    const tShare = roundHalfToEven((100.0 * tS) / Math.max(1, teamTotalShots), 1);

    const lS = lgAcc[z].shots;
    const lG = lgAcc[z].goals;
    const lXg = lgAcc[z].xg;
    const lXgShot = lS ? roundHalfToEven(lXg / Math.max(1, lS), 3) : 0.0;
    const lConv = lS ? roundHalfToEven((100.0 * lG) / Math.max(1, lS), 1) : 0.0;
    const lShare = roundHalfToEven((100.0 * lS) / Math.max(1, lgTotalShots), 1);

    tableRows.push({
      zone: z,
      team_shots: tS,
      shot_share_pct: tShare,
      league_share_pct: lShare,
      goals: tG,
      total_xg: tXg,
      xg_per_shot: tXgShot,
      league_xg_per_shot: lXgShot,
      conversion_pct: tConv,
      league_conversion_pct: lConv,
    });

    const [zx, zy, zw, zh] = zoneGeometry(z, grid);
    zones.push({
      zone_id: z,
      x: zx,
      y: zy,
      width: zw,
      height: zh,
      intensity: roundHalfToEven(tS / Math.max(1, maxZShots), 3),
      value_label: `${tS} (${fmtFixed(tXgShot, 2)})`,
      tooltip: `${z}: ${tS} shots (${tG} goals, ${fmtFixed(tXgShot, 2)} xG/shot vs ${fmtFixed(lXgShot, 2)} lg avg)`,
    });
  }

  let bestZone = tableRows[0] ?? null;
  for (const r of tableRows) {
    if (
      bestZone &&
      (Number(r.goals) > Number(bestZone.goals) ||
        (Number(r.goals) === Number(bestZone.goals) && Number(r.total_xg) > Number(bestZone.total_xg)))
    ) {
      bestZone = r;
    }
  }

  return {
    module_id: "shot_location_zone_efficiency",
    title: `Shot Location & Zone Efficiency — ${team} vs League (${season})`,
    coord_grid: grid,
    summary:
      teamTotalShots === 0 || !bestZone
        ? `No shot data found for ${team} in ${season}.`
        : `${team} took ${teamTotalShots} shots in ${season}. Highest goal output came from ` +
          `${bestZone.zone} (${bestZone.goals} goals from ${bestZone.team_shots} shots, ` +
          `${fmtFixed(Number(bestZone.conversion_pct), 1)}% conversion vs ${fmtFixed(Number(bestZone.league_conversion_pct), 1)}% league avg).`,
    charts: {
      zone_comparison: tableRows,
      total_shots: teamTotalShots,
    },
    pitch: {
      title: `${team} Attacking Half Shot Zones & Shot Map (${grid} Grid)`,
      zones,
      markers: pitchMarkers.slice(0, 120),
      arrows: [],
    },
    table_columns: [
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
    table_rows: tableRows,
    assumptions: cfg,
  };
}

export function executeModule(
  store: DatasetStore,
  moduleId: ModuleId,
  overrides?: Record<string, unknown> | null
): ModuleResultPayload {
  let result: ModuleResultPayload;
  switch (moduleId) {
    case "managerial_impact_tracker":
      result = runManagerialImpactTracker(store, overrides);
      break;
    case "tactical_intervention_comparison":
      result = runTacticalInterventionComparison(store, overrides);
      break;
    case "opposition_scouting_one_pager":
      result = runOppositionScoutingOnePager(store, overrides);
      break;
    case "multi_season_player_progression":
      result = runMultiSeasonPlayerProgression(store, overrides);
      break;
    case "tactical_fit_recruitment_matcher":
      result = runTacticalFitRecruitmentMatcher(store, overrides);
      break;
    case "league_table_vs_underlying_play":
      result = runLeagueTableVsUnderlyingPlay(store, overrides);
      break;
    case "shot_location_zone_efficiency":
      result = runShotLocationZoneEfficiency(store, overrides);
      break;
    default:
      throw new Error(`Unknown analytical module '${String(moduleId)}'.`);
  }
  result.conclusion = buildAnalysisConclusion(result);
  return result;
}

export function runAutomatedVerification(
  store: DatasetStore,
  moduleId: ModuleId,
  params: Record<string, unknown>,
  resultPayload: ModuleResultPayload
): VerificationReport {
  const season = params.season_name ? String(params.season_name) : null;
  const scopedMatches = season
    ? store.matches.filter((m) => m.season_name === season)
    : store.matches;
  const scopedMatchIds = new Set(scopedMatches.map((m) => m.match_id));

  const checks: VerificationCheck[] = [];

  // 1. Official Match Score vs Event Goal Shot Parity
  const totalMatches = scopedMatches.length;
  let sumOfficial = 0;
  let sumEvent = 0;
  let mismatches = 0;
  for (const m of scopedMatches) {
    const offGoals = Math.trunc(m.home_score) + Math.trunc(m.away_score);
    const evs = store.eventsByMatchId.get(m.match_id) || [];
    let evGoals = 0;
    for (const e of evs) {
      if (e.event_type === "Shot" && e.outcome === "Goal") evGoals += 1;
    }
    sumOfficial += offGoals;
    sumEvent += evGoals;
    if (offGoals !== evGoals) mismatches += 1;
  }
  const scoreOk = totalMatches > 0 && mismatches === 0 && sumOfficial === sumEvent;
  checks.push({
    check_id: "score_parity_check",
    label: "Match Score vs Event Goal Parity",
    passed: scoreOk,
    expected: `${sumOfficial} official goals across ${totalMatches} matches`,
    observed: `${sumEvent} event goal shots (${mismatches} match mismatches)`,
    severity: "critical",
  });

  // 2. Shot Count & xG Bounds + Sum Parity
  let shotCount = 0;
  let totalXgRaw = 0;
  let oobXg = 0;
  for (const e of store.events) {
    if (!scopedMatchIds.has(e.match_id)) continue;
    if (e.event_type === "Shot") {
      shotCount += 1;
      totalXgRaw += e.xg;
      if (e.xg <= 0 || e.xg > 1.0) oobXg += 1;
    }
  }
  const totalXg = roundHalfAway(totalXgRaw, 4);
  const shotsOk = shotCount > 0 && oobXg === 0;
  checks.push({
    check_id: "shot_and_xg_bounds_check",
    label: "Shot Count & xG Probability Bounds (0 < xG <= 1.0)",
    passed: shotsOk,
    expected: `${shotCount} shots with valid xG in (0, 1]`,
    observed: `${shotCount} shots, total xG = ${fmtFixed(totalXg, 2)}, ${oobXg} out-of-bounds`,
    severity: "critical",
  });

  // 3. Player Minutes Integrity & Min-Minute Filter Check
  let lRows = 0;
  let minM = 0;
  let maxM = 0;
  let invalidMins = 0;
  for (const l of store.lineups) {
    if (!scopedMatchIds.has(l.match_id)) continue;
    lRows += 1;
    if (lRows === 1 || l.minutes_played < minM) minM = l.minutes_played;
    if (lRows === 1 || l.minutes_played > maxM) maxM = l.minutes_played;
    if (l.minutes_played < 0 || l.minutes_played > 120) invalidMins += 1;
  }
  const minMinutesThreshold = Math.trunc(Number(params.min_minutes ?? 450));
  let violatedThreshold = 0;
  for (const row of resultPayload.table_rows || []) {
    if ("minutes_played" in row && Number(row.minutes_played) < minMinutesThreshold) violatedThreshold += 1;
    if ("season_1_minutes" in row && Number(row.season_1_minutes) < minMinutesThreshold) violatedThreshold += 1;
    if ("season_2_minutes" in row && Number(row.season_2_minutes) < minMinutesThreshold) violatedThreshold += 1;
  }
  const minsOk = invalidMins === 0 && violatedThreshold === 0;
  checks.push({
    check_id: "player_minutes_check",
    label: "Lineup Minutes Integrity & Sample Threshold",
    passed: minsOk,
    expected: `Minutes in [0, 120] and filtered rows >= ${minMinutesThreshold} mins`,
    observed: `${lRows} lineup entries (range ${minM}-${maxM}m), ${violatedThreshold} threshold violations`,
    severity: "high",
  });

  // 4. League Baseline Sanity (Mean Goals/Match & Coordinate Bounds)
  const avgGoalsPerMatch = roundHalfToEven(sumOfficial / Math.max(1, totalMatches), 2);
  let coordOob = 0;
  for (const e of store.events) {
    if (
      e.x < 0 ||
      e.x > 120 ||
      e.y < 0 ||
      e.y > 80 ||
      e.x_105 < 0 ||
      e.x_105 > 105 ||
      e.y_105 < 0 ||
      e.y_105 > 68
    ) {
      coordOob += 1;
    }
  }
  const baselineOk = avgGoalsPerMatch >= 1.0 && avgGoalsPerMatch <= 5.5 && coordOob === 0;
  checks.push({
    check_id: "league_baseline_and_coords_check",
    label: "League Scoring Baseline & Dual-Grid Coordinate Bounds",
    passed: baselineOk,
    expected: "1.0 <= goals/match <= 5.5 and 0 coordinates outside 120x80 / 105x68",
    observed: `${fmtFixed(avgGoalsPerMatch, 2)} goals/match, ${coordOob} coordinate violations`,
    severity: "high",
  });

  // 5. Module-Specific Reconciliation
  let moduleCheckPassed = true;
  let moduleExpected = "Module aggregates reconcile with raw event table";
  let moduleObserved = `Verified ${moduleId} payload (${(resultPayload.table_rows || []).length} rows)`;

  if (moduleId === "shot_location_zone_efficiency") {
    const teamName = String(params.team_name ?? "Arsenal");
    let rawTeamShots = 0;
    for (const e of store.events) {
      if (!scopedMatchIds.has(e.match_id)) continue;
      if (e.event_type === "Shot" && e.team_name === teamName) rawTeamShots += 1;
    }
    const zoneSum = (resultPayload.table_rows || []).reduce((s, r) => s + Math.trunc(Number(r.team_shots || 0)), 0);
    moduleCheckPassed = rawTeamShots === zoneSum && rawTeamShots > 0;
    moduleExpected = `${rawTeamShots} shots for ${teamName}`;
    moduleObserved = `${zoneSum} shots summed across 12 pitch zones`;
  } else if (moduleId === "league_table_vs_underlying_play") {
    const rows = resultPayload.table_rows || [];
    const totalPts = rows.reduce((s, r) => s + Number(r.actual_pts || 0), 0);
    const totalXpts = rows.reduce((s, r) => s + Number(r.xpts || 0), 0);
    moduleCheckPassed = rows.length > 0 && Math.abs(totalPts - totalXpts) <= totalMatches * 0.65;
    moduleExpected = `Simulated xPTS sum within realistic variance of ${fmtFixed(totalPts, 1)} actual pts`;
    moduleObserved = `Actual Pts = ${fmtFixed(totalPts, 1)}, Simulated xPTS = ${fmtFixed(totalXpts, 1)}`;
  } else if (moduleId === "managerial_impact_tracker") {
    const rows = resultPayload.table_rows || [];
    const mBefore = rows.length > 0 ? Math.trunc(Number(rows[0].matches || 0)) : 0;
    const mAfter = rows.length > 1 ? Math.trunc(Number(rows[1].matches || 0)) : 0;
    moduleCheckPassed = rows.length >= 2 && mBefore > 0 && mAfter > 0;
    moduleExpected = "Non-empty match samples in both pre-split and post-split windows (>= 1 match each)";
    moduleObserved = `${mBefore} matches before split, ${mAfter} matches from split onward`;
  } else if (moduleId === "tactical_intervention_comparison") {
    const mw = (resultPayload.charts?.match_window as Record<string, unknown>) || {};
    const mWin = Math.trunc(Number(mw.matches || 0));
    const mSeason = Math.trunc(Number(mw.season_matches || 0));
    moduleCheckPassed = mWin > 0 && mSeason > 0;
    moduleExpected = "Non-empty intervention window and season baseline (>= 1 match each)";
    moduleObserved = `${mWin} matches in intervention window, ${mSeason} in season baseline`;
  } else if (moduleId === "opposition_scouting_one_pager") {
    const kpis = (resultPayload.charts?.style_kpis as Record<string, unknown>) || {};
    const rows = resultPayload.table_rows || [];
    const mOpp = Math.trunc(Number(kpis.matches_played || 0));
    moduleCheckPassed = mOpp > 0 && rows.length > 0;
    moduleExpected = ">= 1 match and observed match-state events for scouted opponent";
    moduleObserved = `${mOpp} matches played, ${rows.length} match-state rows`;
  } else if (moduleId === "multi_season_player_progression") {
    const totalQ = Math.trunc(Number(resultPayload.charts?.total_qualifiers || 0));
    const rows = resultPayload.table_rows || [];
    moduleCheckPassed = totalQ > 0 && rows.length > 0;
    moduleExpected = ">= 1 qualifying player meeting minimum-minutes floor across both seasons";
    moduleObserved = `${totalQ} qualifying players`;
  } else if (moduleId === "tactical_fit_recruitment_matcher") {
    const charts = (resultPayload.charts as Record<string, unknown>) || {};
    const playerMatched = charts.player_matched !== false;
    const currM = Math.trunc(Number(charts.current_club_matches || 0));
    const targM = Math.trunc(Number(charts.target_club_matches || 0));
    const rows = resultPayload.table_rows || [];
    moduleCheckPassed = playerMatched && currM > 0 && targM > 0 && rows.length > 0;
    moduleExpected = "Resolved player and >= 1 season match for both current and target clubs";
    moduleObserved = `player_matched=${playerMatched}, current_club_matches=${currM}, target_club_matches=${targM}`;
  }

  checks.push({
    check_id: "module_reconciliation_check",
    label: "Module Output vs Raw DuckDB Reconciliation",
    passed: moduleCheckPassed,
    expected: moduleExpected,
    observed: moduleObserved,
    severity: "critical",
  });

  const allPassed = checks.every((c) => c.passed);
  return {
    all_passed: allPassed,
    checks_passed: checks.filter((c) => c.passed).length,
    checks_total: checks.length,
    checks,
  };
}
