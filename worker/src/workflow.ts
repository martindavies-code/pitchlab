import { DEFAULT_ASSUMPTIONS, executeModule, mergeAssumptions, runAutomatedVerification } from "./analytics";
import { inspectDatabaseCapabilities } from "./data";
import type { AssumptionsConfig, DatasetStore, Env, ModuleId, WorkflowSession } from "./types";

const WORKFLOW_TTL_SECONDS = 86400; // 24 hours

export class WorkflowNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Workflow session '${sessionId}' not found.`);
  }
}

export class WorkflowBadStateError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

const UNAVAILABLE_SIGNAL_PATTERNS: Array<[RegExp, string, string]> = [
  [
    /\b(sprint speed|top speed|km\/h|high[- ]speed running|distance covered|sprints?|gps|biometric|heart rate)\b/i,
    "Optical/GPS physical tracking metrics (sprint speeds, km/h, high-speed running distance)",
    "No `tracking_frames`, `sprint_speed_kmh`, or physical GPS columns exist in the canonical DuckDB tables (`matches`, `events`, `players`, `teams`, `lineups`).",
  ],
  [
    /\b(freeze[- ]?frame|360|off[- ]ball defender positions?|body[- ]pose|body orientation|shoulder angle|skeleton)\b/i,
    "StatsBomb 360 freeze-frames & body-pose coordinates",
    "While `events.has_freeze_frame` exists in the schema, `freeze_frame_events = 0` in the currently loaded dataset and no body-pose/orientation columns exist.",
  ],
  [
    /\b(tracking coordinates?|22[- ]player positions?|pitch control|voronoi|optical tracking)\b/i,
    "25Hz optical 22-player tracking coordinates",
    "DuckDB contains single-ball event coordinates (`x, y, end_x, end_y`), not continuous multi-player tracking frames.",
  ],
];

const UNSUPPORTED_COMPETITION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(serie a|bundesliga|ligue 1|mls|eredivisie|champions league|world cup 199\d|200\d)\b/i, "Requested competition or historical era"],
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPyList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

function extractEntities(prompt: string, capabilities: ReturnType<typeof inspectDatabaseCapabilities>) {
  const low = prompt.toLowerCase();

  let moduleId: ModuleId = "managerial_impact_tracker";
  if (["manager", "new boss", "coach", "right direction", "since", "arrived", "appointed"].some((k) => low.includes(k))) {
    moduleId = "managerial_impact_tracker";
  } else if (["intervention", "after the change", "custom run", "match run", "ppda", "did anything change"].some((k) => low.includes(k))) {
    moduleId = "tactical_intervention_comparison";
  } else if (["saturday", "what kind of team", "opposition", "scouting", "pre-match", "one-pager", "briefing"].some((k) => low.includes(k))) {
    moduleId = "opposition_scouting_one_pager";
  } else if (["improved most", "last season", "progression", "multi-season", "year over year", "delta"].some((k) => low.includes(k))) {
    moduleId = "multi_season_player_progression";
  } else if (["fit the way we play", "fit our", "recruitment", "would this player fit", "signing", "matcher"].some((k) => low.includes(k))) {
    moduleId = "tactical_fit_recruitment_matcher";
  } else if (["higher in the table", "deserved", "expected points", "xpts", "overperforming", "underperforming", "league table"].some((k) => low.includes(k))) {
    moduleId = "league_table_vs_underlying_play";
  } else if (["where are we shooting", "shot location", "shot zone", "zone efficiency", "conversion", "heatmap"].some((k) => low.includes(k))) {
    moduleId = "shot_location_zone_efficiency";
  }

  const teams = capabilities.teams.map((t) => t.team_name);
  const matchedTeams: string[] = [];
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
    arsenal: "Arsenal",
    liverpool: "Liverpool",
    chelsea: "Chelsea",
  };
  for (const [alias, canon] of Object.entries(aliases)) {
    if (low.includes(alias) && teams.includes(canon) && !matchedTeams.includes(canon)) {
      matchedTeams.push(canon);
    }
  }
  for (const t of teams) {
    if (low.includes(t.toLowerCase()) && !matchedTeams.includes(t)) {
      matchedTeams.push(t);
    }
  }

  let matchedPlayer = DEFAULT_ASSUMPTIONS.player_name;
  for (const p of capabilities.players) {
    const pname = p.player_name;
    const parts = pname.split(/\s+/);
    const last = parts[parts.length - 1].toLowerCase();
    const lastRe = new RegExp(`\\b${escapeRegex(last)}\\b`, "i");
    if (low.includes(pname.toLowerCase()) || (last.length >= 4 && lastRe.test(low))) {
      matchedPlayer = pname;
      break;
    }
  }

  let composite = DEFAULT_ASSUMPTIONS.skill_composite;
  if (["box threat", "goal threat", "finishing", "xg"].some((k) => low.includes(k))) {
    composite = "box_threat";
  } else if (["defensive", "disruption", "pressing", "tackle", "interception"].some((k) => low.includes(k))) {
    composite = "defensive_disruption";
  } else if (["chance creation", "creativity", "key pass", "assist"].some((k) => low.includes(k))) {
    composite = "chance_creation";
  } else if (["progression", "progressive", "carry", "ball progression"].some((k) => low.includes(k))) {
    composite = "ball_progression";
  }

  const normalisation = ["padj", "possession-adjusted", "possession adjusted"].some((k) => low.includes(k))
    ? "possession_adjusted"
    : "per_90";
  const coordGrid = low.includes("105") || low.includes("metric") ? "105x68" : "120x80";

  const minMatch = low.match(/(\d{3,4})\s*(?:min|minutes)/);
  const minMinutes = minMatch ? parseInt(minMatch[1], 10) : DEFAULT_ASSUMPTIONS.min_minutes;
  const explicitMinMins = Boolean(minMatch);

  const seasons = capabilities.seasons.length ? capabilities.seasons : ["2024/2025"];
  let seasonName =
    low.includes("2023") && !low.includes("2024/2025")
      ? "2023/2024"
      : seasons.length
        ? seasons[0]
        : "2024/2025";
  if (seasons.includes("2024/2025") && low.includes("2024")) {
    seasonName = "2024/2025";
  }

  const teamName = matchedTeams.length ? matchedTeams[0] : DEFAULT_ASSUMPTIONS.team_name;
  const opponentName = matchedTeams.length ? matchedTeams[0] : DEFAULT_ASSUMPTIONS.opponent_name;
  let targetClub = matchedTeams.length ? matchedTeams[0] : DEFAULT_ASSUMPTIONS.target_club;
  if (matchedTeams.length >= 2) {
    targetClub = matchedTeams[1];
  }

  const missingRequirements: Array<{ requirement: string; reason: string }> = [];
  for (const [pattern, reqName, detail] of UNAVAILABLE_SIGNAL_PATTERNS) {
    if (pattern.test(low)) {
      missingRequirements.push({ requirement: reqName, reason: detail });
    }
  }
  for (const [pattern, reqName] of UNSUPPORTED_COMPETITION_PATTERNS) {
    const m = low.match(pattern);
    if (m) {
      const compNames = Array.from(new Set(capabilities.competitions.map((c) => c.competition_name)));
      const loadedComps = compNames.length ? compNames.join(", ") : "none";
      missingRequirements.push({
        requirement: `${reqName}: '${m[0]}'`,
        reason: `Connected DuckDB only covers [${loadedComps}] across seasons ${formatPyList(capabilities.seasons)}.`,
      });
    }
  }

  return {
    module_id: moduleId,
    params: mergeAssumptions({
      season_name: seasonName,
      team_name: teamName,
      opponent_name: opponentName,
      player_name: matchedPlayer,
      target_club: targetClub,
      min_minutes: minMinutes,
      normalisation,
      coord_grid: coordGrid,
      skill_composite: composite,
    }),
    explicit_min_mins: explicitMinMins,
    explicit_team: matchedTeams.length > 0,
    missing_requirements: missingRequirements,
  };
}

function buildTransparentPlan(session: WorkflowSession) {
  const mId = session.module_id;
  const p = session.params;
  const normDesc =
    p.normalisation === "possession_adjusted"
      ? "Possession-Adjusted (PAdj: defensive actions scaled by 50 / (100 - Team Possession %))"
      : "Per-90 Minutes (Raw Count / Minutes Played * 90)";

  const planDescriptions: Record<
    ModuleId,
    { objective: string; metrics: string[]; caveats: string[] }
  > = {
    managerial_impact_tracker: {
      objective: `Track rolling ${p.rolling_window}-match PPG and xG created vs conceded for ${p.team_name} in ${p.season_name}.`,
      metrics: [
        `Rolling ${p.rolling_window}-match Points Per Game (3=W, 1=D, 0=L)`,
        `Rolling ${p.rolling_window}-match xG For vs xG Against (from shot-level \`events.xg\`)`,
        `Vertical milestone split at Matchweek ${p.milestone_match_week} (or detected manager change)`,
      ],
      caveats: [
        "Early-season rolling windows (< 4 matches) have smaller sample denominators.",
        "Fixture difficulty and finishing variance can separate actual PPG from underlying xG differential.",
      ],
    },
    tactical_intervention_comparison: {
      objective: `Compare ${p.team_name} tactical style during MW ${p.start_mw}–${p.end_mw} against full ${p.season_name} season average.`,
      metrics: [
        `PPDA (opponent passes vs defensive actions above x_105 >= ${p.ppda_def_line_x}m)`,
        "Build-up Directness (% of passes classified as High/Long passes)",
        `High Turnovers/90 (ball recoveries/interceptions won at x_105 >= ${p.high_turnover_x_threshold}m)`,
        `Progressive Passes/90 (completed passes moving >= ${p.prog_pass_min_dist}m closer to goal or entering box)`,
      ],
      caveats: [
        "Short custom match runs (e.g. 4–8 matches) are sensitive to opponent strength and red-card game states.",
      ],
    },
    opposition_scouting_one_pager: {
      objective: `Generate pre-match opposition scouting briefing for ${p.opponent_name} (${p.season_name}).`,
      metrics: [
        "6-Zone Pressing Trigger Heatmap across pitch thirds and width channels",
        "Primary & secondary tactical formations",
        "Match-state shape & directness splits (`winning`, `drawing`, `losing`)",
        "Top 4 attacking threats ranked by cumulative xG + key passes + progressions",
      ],
      caveats: [
        "Match-state subsamples (`losing` vs `winning`) vary in minutes depending on how often the opponent trailed.",
      ],
    },
    multi_season_player_progression: {
      objective: `Rank qualifying players from ${p.season_1} to ${p.season_2} on the '${p.skill_composite}' composite.`,
      metrics: [
        `Composite formula for \`${p.skill_composite}\` normalized via ${normDesc}`,
        `Minimum sample filter: >= ${p.min_minutes} minutes played in BOTH ${p.season_1} and ${p.season_2}`,
      ],
      caveats: [
        "Players who changed tactical roles or clubs between seasons may show role-driven rather than pure skill deltas.",
      ],
    },
    tactical_fit_recruitment_matcher: {
      objective: `Evaluate tactical fit of ${p.player_name} for ${p.target_club} across 6 team style dimensions.`,
      metrics: [
        "6-Axis Style Overlap (PPDA, Possession Share, Build-up Directness, High Turnovers/90, Prog Passes/90, Box Entries/90)",
        "0–100% Composite Tactical Fit Score + Explicit Adaptation Risk Flags",
      ],
      caveats: [
        "Team-environment comparison reflects the tactical demands of the player's current side alongside individual event footprints.",
      ],
    },
    league_table_vs_underlying_play: {
      objective: `Compute exact shot-level Poisson-binomial xPTS across ${p.season_name} to expose over/underperformance.`,
      metrics: [
        "Match win/draw/loss probabilities derived from exact shot-level xG convolution",
        "Expected Points (`xPTS`) vs Official Points residual (`Actual Pts - xPTS`)",
      ],
      caveats: [
        "Shot-level xPTS does not account for non-shot dangerous attacks (e.g. unshot cutbacks) or red-card timing.",
      ],
    },
    shot_location_zone_efficiency: {
      objective: `Map ${p.team_name} shot volume, xG/shot, goals, and conversion across 10 pitch zones vs league average (${p.season_name}).`,
      metrics: [
        `Spatial mapping rendered on \`${p.coord_grid}\` coordinate grid`,
        "Zone Shot Share %, xG/Shot, and Goal Conversion % benchmarked against full league average",
      ],
      caveats: [
        "Low-volume peripheral zones (e.g., Wide Wings) can show volatile conversion percentages.",
      ],
    },
  };

  const spec = planDescriptions[mId];
  return {
    module_id: mId,
    objective: spec.objective,
    sample_filters: {
      season_name: p.season_name,
      team_name: p.team_name,
      opponent_name: p.opponent_name,
      min_minutes: p.min_minutes,
      matchweek_window: `MW ${p.start_mw}–${p.end_mw}`,
    },
    normalisation_method: normDesc,
    coord_grid: p.coord_grid,
    metrics: spec.metrics,
    statistical_caveats: spec.caveats,
  };
}

async function saveSession(env: Env, session: WorkflowSession): Promise<void> {
  await env.PITCHLAB_KV.put(`workflow:${session.session_id}`, JSON.stringify(session), {
    expirationTtl: WORKFLOW_TTL_SECONDS,
  });
}

export async function getWorkflowSession(env: Env, sessionId: string): Promise<WorkflowSession> {
  const session = await env.PITCHLAB_KV.get<WorkflowSession>(`workflow:${sessionId}`, "json");
  if (!session) throw new WorkflowNotFoundError(sessionId);
  return session;
}

export async function startWorkflowSession(
  env: Env,
  store: DatasetStore,
  prompt: string
): Promise<WorkflowSession> {
  const capabilities = inspectDatabaseCapabilities(store);
  const parsed = extractEntities(prompt, capabilities);
  const sessionId = crypto.randomUUID().slice(0, 12);

  const clarifyingQuestions: WorkflowSession["clarifying_questions"] = [];
  const moduleId = parsed.module_id;
  const params = parsed.params;

  if (
    !parsed.explicit_team &&
    (moduleId === "managerial_impact_tracker" ||
      moduleId === "tactical_intervention_comparison" ||
      moduleId === "opposition_scouting_one_pager" ||
      moduleId === "shot_location_zone_efficiency")
  ) {
    const field = moduleId === "opposition_scouting_one_pager" ? "opponent_name" : "team_name";
    clarifyingQuestions.push({
      field,
      question: "Which club should be scoped for this tactical analysis?",
      options: capabilities.teams.map((t) => t.team_name),
      default: params[field],
    });
  }

  if (moduleId === "multi_season_player_progression" && !parsed.explicit_min_mins) {
    clarifyingQuestions.push({
      field: "min_minutes",
      question: "What minimum minutes threshold per season should qualify a player?",
      options: [270, 450, 720, 900],
      default: params.min_minutes,
    });
    clarifyingQuestions.push({
      field: "skill_composite",
      question: "Which tactical skill composite defines 'most improved'?",
      options: ["ball_progression", "box_threat", "defensive_disruption", "chance_creation"],
      default: params.skill_composite,
    });
  }

  if (clarifyingQuestions.length === 0) {
    clarifyingQuestions.push({
      field: "normalisation",
      question: "Confirm normalization baseline before checking DuckDB data feasibility:",
      options: ["per_90", "possession_adjusted"],
      default: params.normalisation,
    });
  }

  const session: WorkflowSession = {
    session_id: sessionId,
    prompt,
    stage: 1,
    stage_name: "intent_clarification",
    status: "awaiting_approval",
    module_id: moduleId,
    params,
    clarifying_questions: clarifyingQuestions,
    missing_requirements: parsed.missing_requirements,
    feasibility: null,
    execution_plan: null,
    verification: null,
    result: null,
  };

  await saveSession(env, session);
  return session;
}

export async function confirmStage1AndCheckFeasibility(
  env: Env,
  store: DatasetStore,
  sessionId: string,
  clarifications?: Record<string, unknown> | null
): Promise<WorkflowSession> {
  const session = await getWorkflowSession(env, sessionId);
  if (clarifications) {
    session.params = mergeAssumptions({ ...session.params, ...clarifications });
  }

  const capabilities = inspectDatabaseCapabilities(store);
  const missing = [...session.missing_requirements];

  const counts = capabilities.table_counts;
  if (counts.matches === 0 || counts.events === 0) {
    missing.push({
      requirement: "Populated match & event tables",
      reason: "DuckDB currently has 0 matches or 0 events. Load StatsBomb Open Data or upload a file first.",
    });
  }

  const season = session.params.season_name;
  if (capabilities.seasons.length > 0 && !capabilities.seasons.includes(season)) {
    missing.push({
      requirement: `Season '${season}' coverage`,
      reason: `Available seasons in DuckDB: ${formatPyList(capabilities.seasons)}.`,
    });
  }

  const feasible = missing.length === 0;
  session.stage = 2;
  session.stage_name = "data_feasibility_check";
  session.status = feasible ? "awaiting_approval" : "halted_infeasible";
  session.feasibility = {
    feasible,
    checked_tables: Object.keys(counts),
    table_counts: counts,
    available_seasons: capabilities.seasons,
    available_competitions: capabilities.competitions.map((c) => c.competition_name),
    capabilities: capabilities.capabilities,
    missing_requirements: missing,
    halt_message: !feasible
      ? "FEASIBILITY HALT: Required fields or competition coverage do not exist in the connected DuckDB dataset. PitchLab Studio refuses to invent proxy metrics for missing data."
      : "All required DuckDB tables, columns, coordinates, and season fixtures verified present.",
  };

  await saveSession(env, session);
  return session;
}

export async function approveStage2BuildPlan(
  env: Env,
  sessionId: string
): Promise<WorkflowSession> {
  const session = await getWorkflowSession(env, sessionId);
  if (!session.feasibility?.feasible) {
    throw new WorkflowBadStateError(
      "Cannot advance past Stage 2: Feasibility check halted due to missing data."
    );
  }

  session.stage = 3;
  session.stage_name = "execution_plan";
  session.status = "awaiting_approval";
  session.execution_plan = buildTransparentPlan(session);
  await saveSession(env, session);
  return session;
}

export async function approveStage3ExecuteAndVerify(
  env: Env,
  store: DatasetStore,
  sessionId: string,
  paramEdits?: Record<string, unknown> | null
): Promise<WorkflowSession> {
  const session = await getWorkflowSession(env, sessionId);
  if (paramEdits) {
    session.params = mergeAssumptions({ ...session.params, ...paramEdits });
    session.execution_plan = buildTransparentPlan(session);
  }

  const result = executeModule(store, session.module_id, session.params as unknown as Record<string, unknown>);
  const verification = runAutomatedVerification(
    store,
    session.module_id,
    session.params as unknown as Record<string, unknown>,
    result
  );

  session.stage = 4;
  session.stage_name = "automated_verification";
  session.status = verification.all_passed ? "awaiting_approval" : "verification_warning";
  session.verification = verification;
  session.result = result;
  await saveSession(env, session);
  return session;
}

export async function approveStage4Render(
  env: Env,
  sessionId: string
): Promise<WorkflowSession> {
  const session = await getWorkflowSession(env, sessionId);
  if (session.result === null) {
    throw new WorkflowBadStateError("Cannot render Stage 5 before executing Stage 4 verification.");
  }

  session.stage = 5;
  session.stage_name = "interactive_render";
  session.status = "completed";
  await saveSession(env, session);
  return session;
}

export async function overrideAssumptionsAndRerun(
  env: Env,
  store: DatasetStore,
  sessionId: string,
  assumptionsOverride: Record<string, unknown>
): Promise<WorkflowSession> {
  const session = await getWorkflowSession(env, sessionId);
  session.params = mergeAssumptions({ ...session.params, ...assumptionsOverride });
  session.execution_plan = buildTransparentPlan(session);
  const result = executeModule(store, session.module_id, session.params as unknown as Record<string, unknown>);
  const verification = runAutomatedVerification(
    store,
    session.module_id,
    session.params as unknown as Record<string, unknown>,
    result
  );

  session.stage = 5;
  session.stage_name = "interactive_render";
  session.status = "completed";
  session.verification = verification;
  session.result = result;
  await saveSession(env, session);
  return session;
}
