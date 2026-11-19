import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as nodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");

// Resolve extensionless TypeScript imports (e.g. "./conclusion" -> "./conclusion.ts")
// across Node >= 22.6.0 (registerHooks where available, Module.register fallback on older 22.x).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !specifier.endsWith(".ts") &&
        !specifier.endsWith(".js") &&
        !specifier.endsWith(".mjs")
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      return nextResolve(specifier, context);
    },
  });
} else if (typeof nodeModule.register === "function") {
  const hookSource = `export function resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".js") &&
      !specifier.endsWith(".mjs")
    ) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  }`;
  nodeModule.register(`data:text/javascript;base64,${Buffer.from(hookSource).toString("base64")}`);
}

const { getDatasetStore, invalidateDatasetCache } = await import("../src/data.ts");
const { executeModule, runAutomatedVerification } = await import("../src/analytics.ts");
const { buildAnalysisConclusion, extractClubMentions, findMentionedTeam } = await import("../src/conclusion.ts");
const {
  approveStage2BuildPlan,
  approveStage3ExecuteAndVerify,
  approveStage4Render,
  confirmStage1AndCheckFeasibility,
  overrideAssumptionsAndRerun,
  startWorkflowSession,
} = await import("../src/workflow.ts");
const workerEntry = (await import("../src/index.ts")).default;

let tempFixtureDir = null;

function resolvePythonExecutable() {
  const candidates = [
    process.env.PYTHON,
    path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(REPO_ROOT, ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if ((candidate.includes(path.sep) || candidate.includes("/")) && !fs.existsSync(candidate)) {
      continue;
    }
    try {
      execFileSync(candidate, ["-c", "import duckdb"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try next Python candidate
    }
  }
  throw new Error(
    "Unable to locate a Python interpreter with duckdb installed to prepare a temporary KV fixture. " +
      "Set PYTHON, PITCHLAB_KV_BULK_PATH, or run worker/scripts/export-kv-data.py."
  );
}

function loadBulkKvEntries() {
  const overridePath = process.env.PITCHLAB_KV_BULK_PATH?.trim();
  if (overridePath) {
    if (!fs.existsSync(overridePath)) {
      throw new Error(`PITCHLAB_KV_BULK_PATH does not exist: ${overridePath}`);
    }
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  }

  const defaultBulkPath = path.join(WORKER_ROOT, "data", "kv-bulk.json");
  if (fs.existsSync(defaultBulkPath)) {
    return JSON.parse(fs.readFileSync(defaultBulkPath, "utf8"));
  }

  tempFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pitchlab-worker-kv-"));
  const tempBulkPath = path.join(tempFixtureDir, "kv-bulk.json");
  try {
    const pythonExe = resolvePythonExecutable();
    const exportScript = path.join(WORKER_ROOT, "scripts", "export-kv-data.py");
    execFileSync(pythonExe, [exportScript, "--in-memory", "--output", tempBulkPath], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return JSON.parse(fs.readFileSync(tempBulkPath, "utf8"));
  } catch (err) {
    fs.rmSync(tempFixtureDir, { recursive: true, force: true });
    tempFixtureDir = null;
    throw err;
  }
}

test.after(() => {
  if (tempFixtureDir && fs.existsSync(tempFixtureDir)) {
    fs.rmSync(tempFixtureDir, { recursive: true, force: true });
    tempFixtureDir = null;
  }
});

const bulkEntries = loadBulkKvEntries();
const backingMap = new Map(bulkEntries.map((item) => [item.key, item.value]));
const sessionKv = new Map();

function makeEnv(kvMap = backingMap) {
  return {
    PITCHLAB_KV: {
      async get(key, type) {
        if (sessionKv.has(key)) {
          const val = sessionKv.get(key);
          return type === "json" ? JSON.parse(val) : val;
        }
        if (!kvMap.has(key)) return null;
        const val = kvMap.get(key);
        if (type === "json") {
          return typeof val === "string" ? JSON.parse(val) : val;
        }
        return typeof val === "string" ? val : JSON.stringify(val);
      },
      async put(key, value) {
        sessionKv.set(key, typeof value === "string" ? value : JSON.stringify(value));
      },
    },
  };
}

invalidateDatasetCache();
const env = makeEnv();
const canonicalStore = await getDatasetStore(env);

function cloneStore(store) {
  const matches = store.matches.map((m) => ({ ...m }));
  const teams = store.teams.map((t) => ({ ...t }));
  const players = store.players.map((p) => ({ ...p }));
  const lineups = store.lineups.map((l) => ({ ...l }));
  const events = store.events.map((e) => ({ ...e }));
  const matchesById = new Map(matches.map((m) => [m.match_id, m]));
  const eventsByMatchId = new Map();
  for (const e of events) {
    let arr = eventsByMatchId.get(e.match_id);
    if (!arr) {
      arr = [];
      eventsByMatchId.set(e.match_id, arr);
    }
    arr.push(e);
  }
  const lineupsByMatchId = new Map();
  for (const l of lineups) {
    let arr = lineupsByMatchId.get(l.match_id);
    if (!arr) {
      arr = [];
      lineupsByMatchId.set(l.match_id, arr);
    }
    arr.push(l);
  }
  return {
    matches,
    teams,
    players,
    lineups,
    events,
    matchesById,
    eventsByMatchId,
    lineupsByMatchId,
    overlayVersion: store.overlayVersion,
  };
}

function makeManagerialFixture({
  beforeMatches = 8,
  afterMatches = 8,
  beforePpg = 1.5,
  afterPpg = 1.5,
  beforeXgf = 1.4,
  afterXgf = 1.4,
  beforeXga = 1.1,
  afterXga = 1.1,
  teamName = "Arsenal",
  seasonName = "2024/2025",
  splitMw = 9,
} = {}) {
  const beforeXgd = Number((beforeXgf - beforeXga).toFixed(2));
  const afterXgd = Number((afterXgf - afterXga).toFixed(2));
  return {
    module_id: "managerial_impact_tracker",
    title: `Managerial Impact Tracker — ${teamName} (${seasonName})`,
    coord_grid: "120x80",
    summary: "Fixture summary.",
    charts: {
      timeline:
        afterMatches > 0
          ? [{ match_week: splitMw + Math.max(0, afterMatches - 1), rolling_ppg: afterPpg, rolling_xgf: afterXgf, rolling_xga: afterXga }]
          : [],
      milestones: [{ match_week: splitMw, previous_manager: "Mgr A", new_manager: "Mgr B" }],
      rolling_window: 4,
    },
    pitch: { title: "", markers: [], arrows: [], zones: [] },
    table_columns: [],
    table_rows: [
      {
        period: `Before MW ${splitMw}`,
        matches: beforeMatches,
        ppg: beforePpg,
        gf_per90: beforeXgf,
        ga_per90: beforeXga,
        xgf_per90: beforeXgf,
        xga_per90: beforeXga,
        xg_diff_per90: beforeXgd,
      },
      {
        period: `From MW ${splitMw} Onwards`,
        matches: afterMatches,
        ppg: afterPpg,
        gf_per90: afterXgf,
        ga_per90: afterXga,
        xgf_per90: afterXgf,
        xga_per90: afterXga,
        xg_diff_per90: afterXgd,
      },
    ],
    assumptions: {
      team_name: teamName,
      season_name: seasonName,
      milestone_match_week: splitMw,
      rolling_window: 4,
    },
  };
}

test("All seven Worker modules pass automated verification on canonical seed", () => {
  const modules = [
    "managerial_impact_tracker",
    "tactical_intervention_comparison",
    "opposition_scouting_one_pager",
    "multi_season_player_progression",
    "tactical_fit_recruitment_matcher",
    "league_table_vs_underlying_play",
    "shot_location_zone_efficiency",
  ];
  for (const modId of modules) {
    const res = executeModule(canonicalStore, modId, { coord_grid: "120x80" });
    assert.ok(res.table_rows.length > 0, `Expected non-empty rows for ${modId}`);
    assert.ok(typeof res.conclusion === "string" && res.conclusion.length > res.summary.length);
    const ver = runAutomatedVerification(canonicalStore, modId, res.assumptions, res);
    assert.equal(ver.all_passed, true, `Verification failed for ${modId}: ${JSON.stringify(ver.checks)}`);
  }
});

test("Managerial verdict direction and component takeaways (Arsenal MW 5 + 3x3 matrix)", () => {
  const arsenal = executeModule(canonicalStore, "managerial_impact_tracker", {
    team_name: "Arsenal",
    season_name: "2024/2025",
    milestone_match_week: 5,
  });
  const [before, after] = arsenal.table_rows;
  assert.equal(before.ppg, 1.5);
  assert.equal(after.ppg, 1.93);
  assert.equal(before.xg_diff_per90, 1.25);
  assert.equal(after.xg_diff_per90, 0.3);

  const concl = arsenal.conclusion;
  assert.match(concl, /Mixed/);
  assert.match(concl, /points per game have risen/);
  assert.match(concl, /xG differential has declined/);
  assert.ok(concl.includes("-0.95"));
  assert.ok(concl.includes("-0.81") && concl.includes("+0.13"));
  for (const forbidden of ["nearly flat", "finishing", "box survival", "territorial dominance", "match control"]) {
    assert.equal(concl.toLowerCase().includes(forbidden), false, `Forbidden phrase '${forbidden}' in: ${concl}`);
  }

  const matrix = [
    [1.2, 1.6, 1.2, 1.0, 1.4, 2.1, ["Yes", "points output", "xG differential rising"], ["declined", "nearly flat"]],
    [1.2, 1.6, 1.1, 1.1, 1.5, 1.5, ["Partially", "xG differential has improved", "broadly flat"], ["declined"]],
    [1.2, 1.6, 1.1, 1.1, 2.0, 1.4, ["Mixed", "xG differential has improved", "points per game have declined"], ["both points per game"]],
    [1.4, 1.4, 1.1, 1.1, 1.4, 2.0, ["Partially", "points per game have risen", "nearly flat"], ["xG differential has declined", "xG differential has improved"]],
    [1.4, 1.4, 1.1, 1.1, 1.5, 1.5, ["held steady", "minimal change"], ["declined", "risen"]],
    [1.4, 1.4, 1.1, 1.1, 2.0, 1.4, ["Partially", "points per game have declined", "nearly flat"], ["risen"]],
    [1.8, 1.3, 1.0, 1.0, 1.4, 2.0, ["Mixed", "points per game have risen", "xG differential has declined"], ["nearly flat", "chance creation"]],
    [1.8, 1.3, 1.0, 1.0, 1.5, 1.5, ["No", "xG differential has declined", "broadly steady"], ["risen"]],
    [1.8, 1.3, 1.0, 1.4, 2.0, 1.2, ["No", "declined", "both points per game and underlying xG differential"], ["risen", "nearly flat"]],
  ];
  for (const [xgfB, xgfA, xgaB, xgaA, ppgB, ppgA, mustIn, mustOut] of matrix) {
    const out = buildAnalysisConclusion(
      makeManagerialFixture({
        beforePpg: ppgB,
        afterPpg: ppgA,
        beforeXgf: xgfB,
        afterXgf: xgfA,
        beforeXga: xgaB,
        afterXga: xgaA,
      })
    );
    const verdictSentence = out.split(" Across ")[0];
    for (const phrase of mustIn) assert.ok(out.includes(phrase), `Expected '${phrase}' in: ${out}`);
    for (const phrase of mustOut) {
      assert.equal(verdictSentence.includes(phrase), false, `Unexpected '${phrase}' in verdict: ${verdictSentence}`);
    }
  }

  // Component isolation checks
  const xgaOnlyImproved = buildAnalysisConclusion(
    makeManagerialFixture({ beforeXgf: 1.4, afterXgf: 1.4, beforeXga: 1.5, afterXga: 0.9, beforePpg: 1.4, afterPpg: 2.0 })
  );
  assert.ok(xgaOnlyImproved.includes("lower xGA conceded"));
  assert.ok(xgaOnlyImproved.includes("attacking xGF, which remained nearly flat"));
  assert.equal(xgaOnlyImproved.toLowerCase().includes("chance creation"), false);

  const xgfOnlyDropped = buildAnalysisConclusion(
    makeManagerialFixture({ beforeXgf: 1.8, afterXgf: 1.0, beforeXga: 1.0, afterXga: 1.0, beforePpg: 1.8, afterPpg: 1.2 })
  );
  assert.ok(xgfOnlyDropped.includes("attacking xGF dropping"));
  assert.ok(xgfOnlyDropped.includes("xGA conceded stayed nearly flat"));
  assert.equal(xgfOnlyDropped.toLowerCase().includes("higher-value looks"), false);
});

test("Opposition scouting match-state direction (canonical + synthetic)", () => {
  for (const team of ["Arsenal", "Tottenham Hotspur", "Newcastle United"]) {
    const res = executeModule(canonicalStore, "opposition_scouting_one_pager", {
      opponent_name: team,
      season_name: "2024/2025",
    });
    const concl = res.conclusion;
    const states = Object.fromEntries(res.table_rows.map((r) => [r.match_state, r]));
    assert.ok(states.Winning.avg_def_line_m > states.Losing.avg_def_line_m);
    assert.equal(concl.toLowerCase().includes("dropping to"), false);
    assert.equal(concl.toLowerCase().includes("pushing up to"), false);
    assert.ok(concl.includes("average defensive-action location"));
    if (team === "Arsenal") {
      assert.ok(concl.includes("40.3m") && concl.includes("39.6m") && concl.includes("differs only slightly"));
    } else {
      assert.ok(concl.includes("sits higher when leading"));
    }
  }

  const liv = executeModule(canonicalStore, "opposition_scouting_one_pager", {
    opponent_name: "Liverpool",
    season_name: "2024/2025",
  });
  assert.ok(liv.conclusion.includes("identical when leading and chasing (41.7m"));

  const city = executeModule(canonicalStore, "opposition_scouting_one_pager", {
    opponent_name: "Manchester City",
    season_name: "2024/2025",
  });
  assert.ok(city.conclusion.includes("sits deeper when leading (40.4m") && city.conclusion.includes("41.4m"));

  const missingStateConcl = buildAnalysisConclusion({
    module_id: "opposition_scouting_one_pager",
    coord_grid: "120x80",
    title: "",
    summary: "",
    charts: {
      style_kpis: { matches_played: 5, ppda: 11.0, possession_share: 52.0, build_up_directness: 20.0, xg_per90: 1.5 },
      formations: [{ formation: "4-2-3-1", matches: 5 }],
      danger_players: [],
    },
    pitch: { title: "", markers: [], arrows: [], zones: [{ zone_id: "Mid Block - Central Corridor", intensity: 1.0, value_label: "42" }] },
    table_columns: [],
    table_rows: [
      { match_state: "Winning", primary_shape: "4-2-3-1", events: 500, directness_pct: 18.0, prog_pass_share: 10.0, avg_def_line_m: 44.0 },
      { match_state: "Drawing", primary_shape: "4-2-3-1", events: 400, directness_pct: 19.0, prog_pass_share: 11.0, avg_def_line_m: 43.0 },
    ],
    assumptions: { opponent_name: "Arsenal", season_name: "2024/2025" },
  });
  assert.ok(missingStateConcl.includes("insufficient state coverage to compare leading versus chasing"));
  assert.ok(missingStateConcl.includes("44.0m") && !missingStateConcl.includes("chasing ("));
});

test("Missing samples fail verification & refuse fabricated defaults across all 7 modules", async () => {
  // A. intervention MW 30-38 (empty run window + valid season baseline)
  const resA = executeModule(canonicalStore, "tactical_intervention_comparison", {
    team_name: "Arsenal",
    season_name: "2024/2025",
    start_mw: 30,
    end_mw: 38,
  });
  const verA = runAutomatedVerification(canonicalStore, "tactical_intervention_comparison", resA.assumptions, resA);
  const conclA = buildAnalysisConclusion(resA, null, verA);
  assert.equal(resA.charts.match_window.matches, 0);
  assert.equal(resA.charts.match_window.season_matches, 18);
  assert.equal(resA.charts.match_window.intervention_available, false);
  assert.equal(resA.charts.match_window.season_available, true);
  assert.ok(resA.title.includes("Baseline Only") && resA.title.includes("Unavailable"));
  assert.equal(resA.charts.radar.length, 6);
  assert.equal(resA.table_rows.length, 6);
  for (const item of resA.charts.radar) {
    assert.equal(typeof item.season_avg, "number");
    assert.equal(typeof item.season_percentile, "number");
    assert.equal(item.intervention_run, null);
    assert.equal(item.run_percentile, null);
    assert.equal(item.delta, null);
  }
  for (const row of resA.table_rows) {
    assert.equal(typeof row.season_avg, "number");
    assert.equal(typeof row.season_pct, "number");
    assert.equal(row.intervention_run, null);
    assert.equal(row.run_pct, null);
    assert.equal(row.delta, null);
  }
  assert.equal(verA.all_passed, false);
  assert.ok(conclA.includes("Insufficient match sample") && conclA.includes("0 matches"));
  for (const fabricated of ["clear tactical", "12.00 PPDA", "50.0% → 50.0%", "35.0% → 35.0%", "30.0 progressive"]) {
    assert.equal(conclA.includes(fabricated), false, `Fabricated phrase '${fabricated}' in: ${conclA}`);
  }
  assert.ok(conclA.includes("Verification warning"));

  // A2. intervention unknown season 2030/2031 (neither baseline nor run available)
  const resAEmpty = executeModule(canonicalStore, "tactical_intervention_comparison", {
    team_name: "Arsenal",
    season_name: "2030/2031",
    start_mw: 1,
    end_mw: 5,
  });
  const verAEmpty = runAutomatedVerification(canonicalStore, "tactical_intervention_comparison", resAEmpty.assumptions, resAEmpty);
  assert.equal(resAEmpty.charts.match_window.matches, 0);
  assert.equal(resAEmpty.charts.match_window.season_matches, 0);
  assert.equal(resAEmpty.charts.match_window.season_available, false);
  assert.equal(resAEmpty.charts.match_window.intervention_available, false);
  assert.deepEqual(resAEmpty.charts.radar, []);
  assert.deepEqual(resAEmpty.table_rows, []);
  assert.equal(verAEmpty.all_passed, false);

  // B. managerial 2030/2031
  const resB = executeModule(canonicalStore, "managerial_impact_tracker", {
    team_name: "Arsenal",
    season_name: "2030/2031",
  });
  const verB = runAutomatedVerification(canonicalStore, "managerial_impact_tracker", resB.assumptions, resB);
  assert.equal(verB.all_passed, false);
  assert.deepEqual(resB.table_rows, []);
  assert.deepEqual(resB.charts.timeline, []);
  assert.ok(resB.title.includes("No Match Data"));
  assert.ok(resB.conclusion.includes("Insufficient match data") && resB.conclusion.includes("0 matches"));
  assert.equal(resB.conclusion.includes("held steady"), false);

  // B2. One-sided empty managerial window
  const oneSideStore = cloneStore(canonicalStore);
  const dropMatchIds = new Set(
    oneSideStore.matches.filter((m) => m.season_name === "2024/2025" && m.match_week < 15).map((m) => m.match_id)
  );
  oneSideStore.matches = oneSideStore.matches.filter((m) => !dropMatchIds.has(m.match_id));
  oneSideStore.events = oneSideStore.events.filter((e) => !dropMatchIds.has(e.match_id));
  for (const mid of dropMatchIds) {
    oneSideStore.matchesById.delete(mid);
    oneSideStore.eventsByMatchId.delete(mid);
  }
  const resBOne = executeModule(oneSideStore, "managerial_impact_tracker", {
    team_name: "Arsenal",
    season_name: "2024/2025",
    milestone_match_week: 15,
  });
  const verBOne = runAutomatedVerification(oneSideStore, "managerial_impact_tracker", resBOne.assumptions, resBOne);
  assert.equal(resBOne.table_rows[0].matches, 0);
  assert.equal(resBOne.table_rows[0].ppg, null);
  assert.equal(resBOne.table_rows[0].xg_diff_per90, null);
  assert.ok(resBOne.table_rows[1].matches > 0);
  assert.equal(typeof resBOne.table_rows[1].ppg, "number");
  assert.equal(typeof resBOne.table_rows[1].xg_diff_per90, "number");
  assert.ok(resBOne.title.includes("Incomplete Split"));
  assert.equal(verBOne.all_passed, false);
  assert.ok(resBOne.conclusion.includes("Insufficient pre-split sample"));

  // C. opposition Unknown Club
  const resC = executeModule(canonicalStore, "opposition_scouting_one_pager", {
    opponent_name: "Unknown Club",
    season_name: "2024/2025",
  });
  const verC = runAutomatedVerification(canonicalStore, "opposition_scouting_one_pager", resC.assumptions, resC);
  assert.equal(verC.all_passed, false);
  assert.equal(resC.charts.style_kpis.matches_played, 0);
  assert.equal(resC.charts.style_kpis.ppda, null);
  assert.equal(resC.charts.style_kpis.possession_share, null);
  assert.deepEqual(resC.table_rows, []);
  assert.deepEqual(resC.pitch.zones, []);
  assert.ok(resC.title.includes("No Match Data"));
  assert.ok(resC.conclusion.includes("Insufficient data to scout Unknown Club") && resC.conclusion.includes("0 matches"));
  for (const fabricated of ["4-3-3", "balanced", "selective mid-press", "span evenly"]) {
    assert.equal(resC.conclusion.includes(fabricated), false);
  }

  // D. progression 0 qualifiers + all-negative delta case
  const resD = executeModule(canonicalStore, "multi_season_player_progression", { min_minutes: 99999 });
  const verD = runAutomatedVerification(canonicalStore, "multi_season_player_progression", resD.assumptions, resD);
  assert.equal(verD.all_passed, false);
  assert.deepEqual(resD.table_rows, []);
  assert.deepEqual(resD.charts.leaderboard, []);
  assert.ok(resD.title.includes("No Qualifiers"));
  assert.ok(resD.conclusion.includes("Insufficient qualifying player sample") && resD.conclusion.includes("0 players"));

  const allDropConcl = buildAnalysisConclusion({
    module_id: "multi_season_player_progression",
    coord_grid: "120x80",
    title: "",
    summary: "",
    charts: { composite: "ball_progression", normalisation: "per_90", total_qualifiers: 2 },
    pitch: { title: "", markers: [], arrows: [], zones: [] },
    table_columns: [],
    table_rows: [
      { player_name: "Player One", team_name: "Arsenal", position: "CM", season_1_score: 5.0, season_2_score: 4.5, delta: -0.5, pct_change: -10.0 },
      { player_name: "Player Two", team_name: "Chelsea", position: "CM", season_1_score: 4.0, season_2_score: 3.0, delta: -1.0, pct_change: -25.0 },
    ],
    assumptions: { season_1: "2023/2024", season_2: "2024/2025", min_minutes: 450 },
  });
  assert.ok(allDropConcl.includes("every qualifier declined"));
  assert.equal(allDropConcl.includes("improved the most"), false);

  // E. tactical fit unmatched player, unknown season, and valid same-club request
  const resE1 = executeModule(canonicalStore, "tactical_fit_recruitment_matcher", {
    player_name: "Nonexistent Player",
    target_club: "Arsenal",
  });
  const verE1 = runAutomatedVerification(canonicalStore, "tactical_fit_recruitment_matcher", resE1.assumptions, resE1);
  assert.equal(verE1.all_passed, false);
  assert.ok(resE1.title.includes("Nonexistent Player") && resE1.title.includes("Player Not Found"));
  assert.equal(JSON.stringify(resE1).includes("David Raya"), false);
  assert.equal(resE1.charts.player_matched, false);
  assert.equal(resE1.charts.fit_score, null);
  assert.equal(resE1.charts.current_club, null);
  assert.deepEqual(resE1.charts.radar, []);
  assert.deepEqual(resE1.charts.adaptation_risks, []);
  assert.deepEqual(resE1.table_rows, []);
  assert.deepEqual(resE1.pitch.markers, []);
  assert.equal(resE1.summary.includes("minimal tactical friction"), false);
  assert.ok(resE1.conclusion.includes("Insufficient data to evaluate tactical fit for Nonexistent Player"));

  const resE2 = executeModule(canonicalStore, "tactical_fit_recruitment_matcher", {
    player_name: "Cole Palmer",
    target_club: "Arsenal",
    season_name: "2030/2031",
  });
  const verE2 = runAutomatedVerification(canonicalStore, "tactical_fit_recruitment_matcher", resE2.assumptions, resE2);
  assert.equal(verE2.all_passed, false);
  assert.equal(resE2.charts.fit_score, null);
  assert.deepEqual(resE2.charts.radar, []);
  assert.deepEqual(resE2.table_rows, []);
  assert.deepEqual(resE2.pitch.markers, []);
  assert.ok(resE2.conclusion.includes("Insufficient match data in 2030/2031"));

  const resESame = executeModule(canonicalStore, "tactical_fit_recruitment_matcher", {
    player_name: "Bukayo Saka",
    target_club: "Arsenal",
  });
  const verESame = runAutomatedVerification(canonicalStore, "tactical_fit_recruitment_matcher", resESame.assumptions, resESame);
  assert.equal(verESame.all_passed, true);
  assert.equal(resESame.charts.player_matched, true);
  assert.equal(resESame.charts.fit_score, 99);
  assert.equal(resESame.table_rows.length, 6);

  // F & G. League xPTS 2030/2031 & Shot zones Unknown Club
  const resF = executeModule(canonicalStore, "league_table_vs_underlying_play", { season_name: "2030/2031" });
  const verF = runAutomatedVerification(canonicalStore, "league_table_vs_underlying_play", resF.assumptions, resF);
  assert.equal(verF.all_passed, false);
  assert.deepEqual(resF.table_rows, []);
  assert.deepEqual(resF.charts.scatter, []);
  assert.ok(resF.title.includes("No Match Data"));
  assert.ok(resF.conclusion.includes("Insufficient match data in 2030/2031"));

  const resG = executeModule(canonicalStore, "shot_location_zone_efficiency", {
    team_name: "Unknown Club",
    season_name: "2024/2025",
  });
  const verG = runAutomatedVerification(canonicalStore, "shot_location_zone_efficiency", resG.assumptions, resG);
  assert.equal(verG.all_passed, false);
  assert.deepEqual(resG.table_rows, []);
  assert.deepEqual(resG.charts.zone_comparison, []);
  assert.deepEqual(resG.pitch.zones, []);
  assert.deepEqual(resG.pitch.markers, []);
  assert.ok(resG.title.includes("No Shot Data"));
  assert.ok(resG.conclusion.includes("Insufficient shot data for Unknown Club"));

  // Standalone Worker HTTP route must attach verification warning to result.conclusion
  const req = new Request("https://local.test/api/modules/tactical_intervention_comparison/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      overrides: { team_name: "Arsenal", season_name: "2024/2025", start_mw: 30, end_mw: 38 },
    }),
  });
  const resp = await workerEntry.fetch(req, env);
  assert.equal(resp.status, 200);
  const payload = await resp.json();
  assert.equal(payload.verification.all_passed, false);
  assert.ok(payload.result.conclusion.includes("Insufficient match sample"));
  assert.ok(payload.result.conclusion.includes("Verification warning"));

  // Legitimate 0 high turnovers must remain 0.0 (not default 4.0)
  const zeroHtStore = cloneStore(canonicalStore);
  for (const e of zeroHtStore.events) {
    if (e.team_name === "Arsenal" && (e.event_type === "Interception" || e.event_type === "Ball Recovery" || e.event_type === "Duel")) {
      e.is_high_turnover = false;
      e.x_105 = 30.0;
    }
  }
  const resZeroHt = executeModule(zeroHtStore, "tactical_intervention_comparison", {
    team_name: "Arsenal",
    season_name: "2024/2025",
    start_mw: 1,
    end_mw: 5,
  });
  const htRow = resZeroHt.table_rows.find((r) => String(r.metric).includes("High Turnovers"));
  assert.equal(htRow.season_avg, 0);
  assert.equal(htRow.intervention_run, 0);

  // Legitimate 0 goals from real shots must produce valid zero-goal analysis
  const zeroGoalsConcl = buildAnalysisConclusion({
    module_id: "shot_location_zone_efficiency",
    coord_grid: "120x80",
    title: "",
    summary: "",
    charts: { total_shots: 14 },
    pitch: { title: "", markers: [], arrows: [], zones: [] },
    table_columns: [],
    table_rows: [
      { zone: "Central Penalty Area", team_shots: 8, shot_share_pct: 57.1, league_share_pct: 45.0, goals: 0, total_xg: 1.35, xg_per_shot: 0.17, league_xg_per_shot: 0.16, conversion_pct: 0.0, league_conversion_pct: 14.0 },
      { zone: "Long Range Central", team_shots: 6, shot_share_pct: 42.9, league_share_pct: 25.0, goals: 0, total_xg: 0.25, xg_per_shot: 0.04, league_xg_per_shot: 0.05, conversion_pct: 0.0, league_conversion_pct: 4.0 },
    ],
    assumptions: { team_name: "Arsenal", season_name: "2024/2025" },
  });
  assert.ok(zeroGoalsConcl.includes("0 goals across those 14 shots"));
  assert.equal(zeroGoalsConcl.includes("Insufficient shot data"), false);
});

test("Club entity resolution, ambiguous terms, non-extreme xPTS focus, and assumption overrides", async () => {
  const allTeams = canonicalStore.teams.map((t) => t.team_name);

  assert.equal(findMentionedTeam("How is Newcastle United performing?", allTeams), "Newcastle United");
  assert.equal(findMentionedTeam("How are Newcastle looking?", allTeams), "Newcastle United");
  assert.equal(findMentionedTeam("Check West Ham United xPTS", allTeams), "West Ham United");
  assert.equal(findMentionedTeam("Check West Ham away form", allTeams), "West Ham United");
  assert.equal(findMentionedTeam("Is Manchester United improving?", allTeams), "Manchester United");
  assert.equal(findMentionedTeam("How are Man United trending?", allTeams), "Manchester United");
  assert.equal(findMentionedTeam("How are Man Utd doing?", allTeams), "Manchester United");
  assert.equal(findMentionedTeam("Scout Manchester City before Saturday", allTeams), "Manchester City");
  assert.equal(findMentionedTeam("Scout Man City's press", allTeams), "Manchester City");
  assert.equal(findMentionedTeam("How do Spurs press?", allTeams), "Tottenham Hotspur");

  // Standalone United / City must be flagged ambiguous, not silently mapped
  assert.equal(findMentionedTeam("How have United performed this season?", allTeams), null);
  assert.equal(findMentionedTeam("How have City performed this season?", allTeams), null);
  const ambU = extractClubMentions("How have United performed?", allTeams);
  assert.deepEqual(ambU.matched_teams, []);
  assert.equal(ambU.ambiguous_term, "United");
  assert.deepEqual(ambU.ambiguous_candidates.sort(), ["Manchester United", "Newcastle United", "West Ham United"]);

  const ambS1 = await startWorkflowSession(env, canonicalStore, "Is United going in the right direction since MW 6?");
  assert.equal(ambS1.explicit_team, false);
  assert.equal(ambS1.clarifying_questions[0].field, "team_name");
  assert.ok(ambS1.clarifying_questions[0].question.includes("United"));
  assert.deepEqual(ambS1.clarifying_questions[0].options.slice(0, 3), [
    "Manchester United",
    "Newcastle United",
    "West Ham United",
  ]);

  // Team-focused league xPTS where requested club is neither top overperformer nor top underperformer
  const wh1 = await startWorkflowSession(
    env,
    canonicalStore,
    "How has West Ham United performed relative to expected points in 2024/2025?"
  );
  assert.equal(wh1.module_id, "league_table_vs_underlying_play");
  assert.equal(wh1.params.team_name, "West Ham United");
  await confirmStage1AndCheckFeasibility(env, canonicalStore, wh1.session_id);
  await approveStage2BuildPlan(env, wh1.session_id);
  await approveStage3ExecuteAndVerify(env, canonicalStore, wh1.session_id);
  const wh5 = await approveStage4Render(env, wh1.session_id);
  assert.ok(wh5.conclusion.startsWith("In 2024/2025, West Ham United sit #8"));
  assert.ok(wh5.conclusion.includes("#10 on simulated xPTS (17.9 xPTS, -0.9 pts, On Par;"));

  const new1 = await startWorkflowSession(
    env,
    canonicalStore,
    "How did Newcastle United perform relative to expected points in 2023/2024?"
  );
  assert.equal(new1.module_id, "league_table_vs_underlying_play");
  assert.equal(new1.params.team_name, "Newcastle United");
  await confirmStage1AndCheckFeasibility(env, canonicalStore, new1.session_id);
  await approveStage2BuildPlan(env, new1.session_id);
  await approveStage3ExecuteAndVerify(env, canonicalStore, new1.session_id);
  const new5 = await approveStage4Render(env, new1.session_id);
  assert.ok(new5.conclusion.startsWith("In 2023/2024, Newcastle United sit #7"));
  assert.ok(new5.conclusion.includes("#8 on simulated xPTS"));

  // Stage 5 override must replace West Ham United without reintroducing old prompt's team
  const rerun = await overrideAssumptionsAndRerun(env, canonicalStore, wh1.session_id, { team_name: "Chelsea" });
  assert.ok(rerun.conclusion.startsWith("In 2024/2025, Chelsea sit #5"));
  assert.equal(rerun.conclusion.includes("West Ham United"), false);
});
