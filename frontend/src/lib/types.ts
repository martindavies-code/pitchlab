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

export interface PitchMarker {
  x: number;
  y: number;
  radius: number;
  color: string;
  label: string;
  group?: string;
}

export interface PitchArrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label: string;
}

export interface PitchZone {
  zone_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  value_label: string;
  tooltip: string;
}

export interface PitchPayload {
  title: string;
  markers: PitchMarker[];
  arrows: PitchArrow[];
  zones: PitchZone[];
}

export interface ModuleResultPayload {
  module_id: ModuleId;
  title: string;
  coord_grid: CoordGrid;
  summary: string;
  conclusion?: string;
  charts: Record<string, any>;
  pitch: PitchPayload;
  table_columns: string[];
  table_rows: Array<Record<string, any>>;
  assumptions: AssumptionsConfig;
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

export interface ClarifyingQuestion {
  field: string;
  question: string;
  options: Array<string | number>;
  default: string | number;
}

export interface MissingRequirement {
  requirement: string;
  reason: string;
}

export interface WorkflowSession {
  session_id: string;
  prompt: string;
  stage: 1 | 2 | 3 | 4 | 5;
  stage_name: string;
  status: "awaiting_approval" | "halted_infeasible" | "verification_warning" | "completed";
  module_id: ModuleId;
  params: AssumptionsConfig;
  clarifying_questions: ClarifyingQuestion[];
  missing_requirements: MissingRequirement[];
  feasibility: {
    feasible: boolean;
    checked_tables: string[];
    table_counts: Record<string, number>;
    available_seasons: string[];
    available_competitions: string[];
    capabilities: Record<string, any>;
    missing_requirements: MissingRequirement[];
    halt_message: string;
  } | null;
  execution_plan: {
    module_id: ModuleId;
    objective: string;
    sample_filters: Record<string, any>;
    normalisation_method: string;
    coord_grid: CoordGrid;
    metrics: string[];
    statistical_caveats: string[];
  } | null;
  verification: VerificationReport | null;
  result: ModuleResultPayload | null;
  conclusion?: string | null;
}

export interface DatabaseCapabilities {
  table_counts: Record<string, number>;
  table_columns: Record<string, string[]>;
  competitions: Array<{
    competition_id: number;
    competition_name: string;
    season_id: number;
    season_name: string;
    match_count: number;
    data_sources: string;
  }>;
  seasons: string[];
  teams: Array<{
    team_id: number;
    team_name: string;
    manager_name: string;
    primary_formation: string;
  }>;
  players: Array<{
    player_id: number;
    player_name: string;
    team_name: string;
    primary_position: string;
    position_group: string;
  }>;
  date_range: { min_date: string | null; max_date: string | null };
  capabilities: Record<string, any>;
}

export interface ProviderDescriptor {
  provider_id: string;
  display_name: string;
  base_url: string;
  coord_system: string;
  is_configured: boolean;
  api_key_masked: string;
  capabilities: string[];
}
