export interface Env {
  PITCHLAB_KV: KVNamespace;
  ALLOWED_ORIGIN?: string;
}

export type CoordGrid = "120x80" | "105x68";
export type NormalisationMode = "per_90" | "possession_adjusted";
export type ModuleId =
  | "managerial_impact_tracker"
  | "tactical_intervention_comparison"
  | "opposition_scouting_one_pager"
  | "multi_season_player_progression"
  | "tactical_fit_recruitment_matcher"
  | "league_table_vs_underlying_play"
  | "shot_location_zone_efficiency";

export interface MatchRow {
  match_id: number;
  competition_id: number;
  competition_name: string;
  season_id: number;
  season_name: string;
  match_date: string;
  match_week: number;
  home_team_id: number;
  home_team_name: string;
  away_team_id: number;
  away_team_name: string;
  home_score: number;
  away_score: number;
  home_manager: string;
  away_manager: string;
  home_formation: string;
  away_formation: string;
  stadium_name: string | null;
  referee_name: string | null;
  data_source: string;
  coord_system: string;
}

export interface TeamRow {
  team_id: number;
  team_name: string;
  country: string;
  gender: string;
  manager_name: string;
  primary_formation: string;
}

export interface PlayerRow {
  player_id: number;
  player_name: string;
  nickname: string | null;
  team_id: number;
  team_name: string;
  country: string;
  primary_position: string;
  position_group: string;
}

export interface LineupRow {
  match_id: number;
  team_id: number;
  team_name: string;
  player_id: number;
  player_name: string;
  jersey_number: number;
  position_name: string;
  is_starter: boolean;
  minute_on: number;
  minute_off: number;
  minutes_played: number;
  tactical_formation: string;
}

export interface EventRow {
  event_id: string;
  match_id: number;
  index_num: number;
  period: number;
  timestamp: string;
  minute: number;
  second: number;
  possession: number;
  possession_team_id: number;
  possession_team_name: string;
  team_id: number;
  team_name: string;
  player_id: number | null;
  player_name: string | null;
  position_name: string | null;
  event_type: string;
  outcome: string;
  x: number;
  y: number;
  end_x: number | null;
  end_y: number | null;
  x_105: number;
  y_105: number;
  end_x_105: number | null;
  end_y_105: number | null;
  xg: number;
  pass_length: number;
  pass_angle: number;
  pass_height: string | null;
  pass_recipient_id: number | null;
  pass_recipient_name: string | null;
  is_key_pass: boolean;
  is_assist: boolean;
  is_progressive_pass: boolean;
  is_box_entry: boolean;
  is_progressive_carry: boolean;
  carry_distance: number;
  is_defensive_action: boolean;
  is_high_turnover: boolean;
  is_counterpress: boolean;
  under_pressure: boolean;
  has_freeze_frame: boolean;
  shot_body_part: string | null;
  shot_type: string | null;
  shot_technique: string | null;
  tactical_formation: string | null;
  match_state: string;
}

export interface DatasetStore {
  matches: MatchRow[];
  teams: TeamRow[];
  players: PlayerRow[];
  lineups: LineupRow[];
  events: EventRow[];
  matchesById: Map<number, MatchRow>;
  eventsByMatchId: Map<number, EventRow[]>;
  lineupsByMatchId: Map<number, LineupRow[]>;
  overlayVersion: string;
}

export interface OverlayPayload {
  version: string;
  matches: MatchRow[];
  teams: TeamRow[];
  players: PlayerRow[];
  lineups: LineupRow[];
  events: EventRow[];
}

export interface AssumptionsConfig {
  season_name: string;
  season_1: string;
  season_2: string;
  team_name: string;
  opponent_name: string;
  player_name: string;
  target_club: string;
  min_minutes: number;
  normalisation: NormalisationMode;
  coord_grid: CoordGrid;
  rolling_window: number;
  milestone_match_week: number;
  start_mw: number;
  end_mw: number;
  ppda_def_line_x: number;
  high_turnover_x_threshold: number;
  prog_pass_min_dist: number;
  skill_composite: "ball_progression" | "box_threat" | "defensive_disruption" | "chance_creation";
}

export interface VerificationCheck {
  check_id: string;
  label: string;
  passed: boolean;
  expected: string;
  observed: string;
  severity: string;
}

export interface VerificationReport {
  all_passed: boolean;
  checks_passed: number;
  checks_total: number;
  checks: VerificationCheck[];
}

export interface ModuleResultPayload {
  module_id: ModuleId;
  title: string;
  coord_grid: CoordGrid;
  summary: string;
  conclusion?: string;
  charts: Record<string, unknown>;
  pitch: {
    title: string;
    markers: Array<Record<string, unknown>>;
    arrows: Array<Record<string, unknown>>;
    zones: Array<Record<string, unknown>>;
  };
  table_columns: string[];
  table_rows: Array<Record<string, unknown>>;
  assumptions: AssumptionsConfig;
}

export interface WorkflowSession {
  session_id: string;
  prompt: string;
  stage: 1 | 2 | 3 | 4 | 5;
  stage_name: string;
  status: "awaiting_approval" | "halted_infeasible" | "verification_warning" | "completed";
  module_id: ModuleId;
  params: AssumptionsConfig;
  explicit_team?: boolean;
  ambiguous_term?: string | null;
  team_scoped?: boolean;
  player_scoped?: boolean;
  clarifying_questions: Array<{
    field: string;
    question: string;
    options: Array<string | number>;
    default: string | number;
  }>;
  missing_requirements: Array<{ requirement: string; reason: string }>;
  feasibility: {
    feasible: boolean;
    checked_tables: string[];
    table_counts: Record<string, number>;
    available_seasons: string[];
    available_competitions: string[];
    capabilities: Record<string, unknown>;
    missing_requirements: Array<{ requirement: string; reason: string }>;
    halt_message: string;
  } | null;
  execution_plan: {
    module_id: ModuleId;
    objective: string;
    sample_filters: Record<string, unknown>;
    normalisation_method: string;
    coord_grid: CoordGrid;
    metrics: string[];
    statistical_caveats: string[];
  } | null;
  verification: VerificationReport | null;
  result: ModuleResultPayload | null;
  conclusion: string | null;
}
