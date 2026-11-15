import type {
  DatasetStore,
  Env,
  EventRow,
  LineupRow,
  MatchRow,
  OverlayPayload,
  PlayerRow,
  TeamRow,
} from "./types";

interface ManifestPayload {
  version: number;
  eventChunks: number;
  eventColumns: string[];
  stringCols: string[];
  counts: Record<string, number>;
}

interface CorePayload {
  matches: MatchRow[];
  teams: TeamRow[];
  players: PlayerRow[];
  lineups: LineupRow[];
}

const STRING_COL_SET = new Set([
  "possession_team_name",
  "team_name",
  "player_name",
  "position_name",
  "event_type",
  "outcome",
  "pass_height",
  "pass_recipient_name",
  "shot_body_part",
  "shot_type",
  "shot_technique",
  "tactical_formation",
  "match_state",
]);

const BOOL_COL_SET = new Set([
  "is_key_pass",
  "is_assist",
  "is_progressive_pass",
  "is_box_entry",
  "is_progressive_carry",
  "is_defensive_action",
  "is_high_turnover",
  "is_counterpress",
  "under_pressure",
  "has_freeze_frame",
]);

// Per-isolate memory cache (single-flight promise)
let baseDatasetPromise: Promise<{
  matches: MatchRow[];
  teams: TeamRow[];
  players: PlayerRow[];
  lineups: LineupRow[];
  events: EventRow[];
}> | null = null;

let hydratedStore: DatasetStore | null = null;

export function invalidateDatasetCache(): void {
  hydratedStore = null;
}

export function roundHalfToEven(val: number, decimals = 2): number {
  if (!Number.isFinite(val) || val === 0) return 0;
  const neg = val < 0;
  const abs = Math.abs(val);
  const expStr = abs.toExponential(20);
  const [mantissa, expPart] = expStr.split("e");
  const exp = parseInt(expPart, 10);
  const digits = mantissa.replace(".", "");
  const keepLen = exp + 1 + decimals;
  if (keepLen < 0) return 0;

  let roundedInt: bigint;
  if (keepLen === 0) {
    const d0 = parseInt(digits[0], 10);
    let tailNonZero = false;
    for (let i = 1; i < digits.length; i++) {
      if (digits[i] !== "0") {
        tailNonZero = true;
        break;
      }
    }
    roundedInt = d0 > 5 || (d0 === 5 && tailNonZero) ? 1n : 0n;
  } else {
    const padded = digits.padEnd(keepLen + 1, "0");
    const head = padded.slice(0, keepLen);
    const nextDigit = parseInt(padded[keepLen], 10);
    let tailNonZero = false;
    for (let i = keepLen + 1; i < padded.length; i++) {
      if (padded[i] !== "0") {
        tailNonZero = true;
        break;
      }
    }
    let bi = BigInt(head);
    if (nextDigit > 5 || (nextDigit === 5 && (tailNonZero || bi % 2n !== 0n))) {
      bi += 1n;
    }
    roundedInt = bi;
  }

  const res = decimals === 0 ? Number(roundedInt) : Number(roundedInt) / 10 ** decimals;
  if (res === 0) return 0;
  return neg ? -res : res;
}

export function compensatedSum(values: number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of values) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + c;
}

export function roundHalfAway(val: number, decimals = 2): number {
  if (!Number.isFinite(val)) return 0;
  const factor = 10 ** decimals;
  const sign = val < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(val) * factor + 1e-12)) / factor;
}

export function to105x68(x120: number | null, y80: number | null): [number | null, number | null] {
  if (x120 === null || y80 === null) return [null, null];
  const xc = Math.max(0, Math.min(120, Number(x120)));
  const yc = Math.max(0, Math.min(80, Number(y80)));
  return [roundHalfToEven(xc * (105 / 120), 3), roundHalfToEven(yc * (68 / 80), 3)];
}

export function to120x80From105x68(x105: number | null, y68: number | null): [number | null, number | null] {
  if (x105 === null || y68 === null) return [null, null];
  const xc = Math.max(0, Math.min(105, Number(x105)));
  const yc = Math.max(0, Math.min(68, Number(y68)));
  return [roundHalfToEven(xc * (120 / 105), 3), roundHalfToEven(yc * (80 / 68), 3)];
}

export function fromSourceCoords(
  x: number | null,
  y: number | null,
  sourceGrid: string
): [number | null, number | null, number | null, number | null] {
  if (x === null || y === null) return [null, null, null, null];
  const grid = sourceGrid.trim().toLowerCase();
  const fx = Number(x);
  const fy = Number(y);
  let x120: number;
  let y80: number;

  if (grid === "120x80") {
    x120 = Math.max(0, Math.min(120, fx));
    y80 = Math.max(0, Math.min(80, fy));
  } else if (grid === "105x68") {
    const [rx, ry] = to120x80From105x68(fx, fy);
    x120 = rx ?? 0;
    y80 = ry ?? 0;
  } else if (grid === "100x100") {
    x120 = Math.max(0, Math.min(120, fx * 1.2));
    y80 = Math.max(0, Math.min(80, (100 - fy) * 0.8));
  } else if (grid === "1x1") {
    x120 = Math.max(0, Math.min(120, fx * 120));
    y80 = Math.max(0, Math.min(80, fy * 80));
  } else {
    x120 = Math.max(0, Math.min(120, fx));
    y80 = Math.max(0, Math.min(80, fy));
  }

  const [x105, y68] = to105x68(x120, y80);
  return [roundHalfToEven(x120, 3), roundHalfToEven(y80, 3), x105, y68];
}

async function loadBaseDataset(env: Env) {
  const manifest = await env.PITCHLAB_KV.get<ManifestPayload>("dataset:manifest", "json");
  if (!manifest) {
    throw new Error("KV dataset not initialized. Run the KV upload script to populate PITCHLAB_KV.");
  }

  const keysToFetch = [
    env.PITCHLAB_KV.get<CorePayload>("dataset:core", "json"),
    env.PITCHLAB_KV.get<string[]>("dataset:events:vocab", "json"),
    ...Array.from({ length: manifest.eventChunks }, (_, i) =>
      env.PITCHLAB_KV.get<unknown[][]>(`dataset:events:${i}`, "json")
    ),
  ];

  const [core, vocab, ...chunks] = await Promise.all(keysToFetch);
  const coreData = core as CorePayload | null;
  const vocabArr = (vocab as string[] | null) || [];
  if (!coreData) {
    throw new Error("KV key 'dataset:core' missing.");
  }

  const cols = manifest.eventColumns;
  const events: EventRow[] = [];
  for (const chunk of chunks as Array<unknown[][] | null>) {
    if (!chunk) continue;
    for (const tuple of chunk) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const raw = tuple[i];
        if (STRING_COL_SET.has(col)) {
          obj[col] = raw === null || raw === undefined ? null : vocabArr[raw as number];
        } else if (BOOL_COL_SET.has(col)) {
          obj[col] = raw === 1 || raw === true;
        } else {
          obj[col] = raw;
        }
      }
      events.push(obj as unknown as EventRow);
    }
  }

  return {
    matches: coreData.matches,
    teams: coreData.teams,
    players: coreData.players,
    lineups: coreData.lineups,
    events,
  };
}

function buildStore(
  matches: MatchRow[],
  teams: TeamRow[],
  players: PlayerRow[],
  lineups: LineupRow[],
  events: EventRow[],
  overlayVersion: string
): DatasetStore {
  const sortedMatches = [...matches].sort((a, b) => a.match_id - b.match_id);
  const sortedTeams = [...teams].sort((a, b) => a.team_id - b.team_id);
  const sortedPlayers = [...players].sort((a, b) => a.player_id - b.player_id);

  const matchesById = new Map<number, MatchRow>();
  for (const m of sortedMatches) matchesById.set(m.match_id, m);

  const eventsByMatchId = new Map<number, EventRow[]>();
  for (const e of events) {
    let arr = eventsByMatchId.get(e.match_id);
    if (!arr) {
      arr = [];
      eventsByMatchId.set(e.match_id, arr);
    }
    arr.push(e);
  }

  const lineupsByMatchId = new Map<number, LineupRow[]>();
  for (const l of lineups) {
    let arr = lineupsByMatchId.get(l.match_id);
    if (!arr) {
      arr = [];
      lineupsByMatchId.set(l.match_id, arr);
    }
    arr.push(l);
  }

  return {
    matches: sortedMatches,
    teams: sortedTeams,
    players: sortedPlayers,
    lineups,
    events,
    matchesById,
    eventsByMatchId,
    lineupsByMatchId,
    overlayVersion,
  };
}

export async function getDatasetStore(env: Env): Promise<DatasetStore> {
  if (!baseDatasetPromise) {
    baseDatasetPromise = loadBaseDataset(env).catch((err) => {
      baseDatasetPromise = null;
      throw err;
    });
  }
  const base = await baseDatasetPromise;
  const overlay = await env.PITCHLAB_KV.get<OverlayPayload>("overlay:data", "json");
  const overlayVer = overlay?.version || "none";

  if (hydratedStore && hydratedStore.overlayVersion === overlayVer) {
    return hydratedStore;
  }

  if (!overlay || (!overlay.matches.length && !overlay.events.length)) {
    hydratedStore = buildStore(base.matches, base.teams, base.players, base.lineups, base.events, "none");
    return hydratedStore;
  }

  // Merge base + overlay deduplicating by primary key (INSERT OR REPLACE semantics)
  const mergeByKey = <T>(baseArr: T[], ovArr: T[], keyFn: (item: T) => string | number): T[] => {
    const map = new Map<string | number, T>();
    for (const item of baseArr) map.set(keyFn(item), item);
    for (const item of ovArr) map.set(keyFn(item), item);
    return Array.from(map.values());
  };

  const matches = mergeByKey(base.matches, overlay.matches, (m) => m.match_id);
  const teams = mergeByKey(base.teams, overlay.teams, (t) => t.team_id);
  const players = mergeByKey(base.players, overlay.players, (p) => p.player_id);
  const lineups = mergeByKey(base.lineups, overlay.lineups, (l) => `${l.match_id}:${l.player_id}`);
  const events = mergeByKey(base.events, overlay.events, (e) => e.event_id);

  hydratedStore = buildStore(matches, teams, players, lineups, events, overlayVer);
  return hydratedStore;
}

export function inspectDatabaseCapabilities(store: DatasetStore) {
  const table_counts = {
    matches: store.matches.length,
    teams: store.teams.length,
    players: store.players.length,
    lineups: store.lineups.length,
    events: store.events.length,
  };

  const table_columns = {
    matches: store.matches.length ? Object.keys(store.matches[0]) : [],
    teams: store.teams.length ? Object.keys(store.teams[0]) : [],
    players: store.players.length ? Object.keys(store.players[0]) : [],
    lineups: store.lineups.length ? Object.keys(store.lineups[0]) : [],
    events: store.events.length ? Object.keys(store.events[0]) : [],
  };

  const compMap = new Map<
    string,
    {
      competition_id: number;
      competition_name: string;
      season_id: number;
      season_name: string;
      match_count: number;
      sources: Set<string>;
    }
  >();

  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const m of store.matches) {
    if (!minDate || m.match_date < minDate) minDate = m.match_date;
    if (!maxDate || m.match_date > maxDate) maxDate = m.match_date;

    const k = `${m.competition_id}:${m.season_id}`;
    let entry = compMap.get(k);
    if (!entry) {
      entry = {
        competition_id: m.competition_id,
        competition_name: m.competition_name,
        season_id: m.season_id,
        season_name: m.season_name,
        match_count: 0,
        sources: new Set(),
      };
      compMap.set(k, entry);
    }
    entry.match_count += 1;
    entry.sources.add(m.data_source);
  }

  const competitions = Array.from(compMap.values())
    .map((c) => ({
      competition_id: c.competition_id,
      competition_name: c.competition_name,
      season_id: c.season_id,
      season_name: c.season_name,
      match_count: c.match_count,
      data_sources: Array.from(c.sources).join(", "),
    }))
    .sort((a, b) =>
      b.season_name.localeCompare(a.season_name) || a.competition_name.localeCompare(b.competition_name)
    );

  const teams = [...store.teams]
    .sort((a, b) => a.team_name.localeCompare(b.team_name))
    .map((t) => ({
      team_id: t.team_id,
      team_name: t.team_name,
      manager_name: t.manager_name,
      primary_formation: t.primary_formation,
    }));

  const players = [...store.players]
    .sort((a, b) => a.team_name.localeCompare(b.team_name) || a.player_name.localeCompare(b.player_name))
    .map((p) => ({
      player_id: p.player_id,
      player_name: p.player_name,
      team_name: p.team_name,
      primary_position: p.primary_position,
      position_group: p.position_group,
    }));

  const seasons = Array.from(new Set(competitions.map((c) => c.season_name))).sort();
  let freezeFrameCount = 0;
  for (const e of store.events) {
    if (e.has_freeze_frame) freezeFrameCount += 1;
  }

  return {
    table_counts,
    table_columns,
    competitions,
    seasons,
    teams,
    players,
    date_range: {
      min_date: minDate,
      max_date: maxDate,
    },
    capabilities: {
      has_events: table_counts.events > 0,
      has_xg: table_counts.events > 0,
      has_pass_coordinates: table_counts.events > 0,
      has_carries: table_counts.events > 0,
      has_pressures: table_counts.events > 0,
      has_defensive_actions: table_counts.events > 0,
      has_tactical_formations: table_counts.matches > 0,
      has_multi_season: seasons.length >= 2,
      has_360_freeze_frames: freezeFrameCount > 0,
      freeze_frame_events: freezeFrameCount,
      has_tracking_data: false,
      has_physical_sprint_speeds: false,
      has_optical_body_pose: false,
      has_expected_threat_tracking_offball: false,
      has_biometric_heart_rate: false,
    },
  };
}
