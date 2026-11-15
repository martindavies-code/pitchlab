import {
  fromSourceCoords,
  getDatasetStore,
  invalidateDatasetCache,
  roundHalfToEven,
  to105x68,
} from "./data";
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

export const STATSBOMB_BASE_URL = "https://raw.githubusercontent.com/statsbomb/open-data/master/data";

export const PROVIDER_MAPPING_PRESETS: Record<
  string,
  { coord_system: string; columns: Record<string, string> }
> = {
  wyscout: {
    coord_system: "100x100",
    columns: {
      event_id: "id",
      match_id: "matchId",
      minute: "matchTimestamp",
      team_name: "teamName",
      player_name: "playerName",
      event_type: "typePrimary",
      outcome: "outcome",
      x: "locationX",
      y: "locationY",
      end_x: "passEndLocationX",
      end_y: "passEndLocationY",
      xg: "shotXg",
    },
  },
  opta: {
    coord_system: "100x100",
    columns: {
      event_id: "event_id",
      match_id: "match_id",
      minute: "min",
      team_name: "team_name",
      player_name: "player_name",
      event_type: "type_name",
      outcome: "outcome",
      x: "x",
      y: "y",
      end_x: "end_x",
      end_y: "end_y",
      xg: "xG",
    },
  },
  fbref: {
    coord_system: "120x80",
    columns: {
      event_id: "event_id",
      match_id: "match_id",
      minute: "Minute",
      team_name: "Squad",
      player_name: "Player",
      event_type: "Event",
      outcome: "Outcome",
      x: "X",
      y: "Y",
      end_x: "EndX",
      end_y: "EndY",
      xg: "xG",
    },
  },
  understat: {
    coord_system: "1x1",
    columns: {
      event_id: "id",
      match_id: "match_id",
      minute: "minute",
      team_name: "team",
      player_name: "player",
      event_type: "result",
      outcome: "result",
      x: "X",
      y: "Y",
      xg: "xG",
    },
  },
};

function parseCsvText(text: string): { columns: string[]; rows: Array<Record<string, string>> } {
  const cleanText = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < cleanText.length && cleanText[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      if (i + 1 < cleanText.length && cleanText[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell !== "")) records.push(row);
      row = [];
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      if (row.some((cell) => cell !== "")) records.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) records.push(row);
  }

  if (records.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns = records[0].map((c) => c.trim());
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const obj: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      obj[columns[c]] = rec[c] ?? "";
    }
    rows.push(obj);
  }
  return { columns, rows };
}

export function previewUploadedFile(fileBytes: ArrayBuffer, filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".parquet") || lower.endsWith(".pq")) {
    throw new Error(
      "Parquet binary parsing is only available on the local FastAPI backend. Please export as .csv for cloud Worker ingestion."
    );
  }
  if (!lower.endsWith(".csv")) {
    throw new Error(`Unsupported file format for '${filename}'. Upload .csv or .parquet files.`);
  }

  const text = new TextDecoder("utf-8").decode(fileBytes);
  const { columns, rows } = parseCsvText(text);
  const colSet = new Set(columns);

  let suggestedPreset = "opta";
  for (const [presetName, cfg] of Object.entries(PROVIDER_MAPPING_PRESETS)) {
    const presetCols = Object.values(cfg.columns);
    const hits = presetCols.filter((c) => colSet.has(c)).length;
    if (hits >= 4) {
      suggestedPreset = presetName;
      break;
    }
  }

  const coerceCell = (v: string): string | number => {
    const trimmed = v.trim();
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed) && trimmed !== "" && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
    return v;
  };

  const sampleRows = rows.slice(0, 5).map((r) => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = coerceCell(v);
    }
    return out;
  });

  return {
    filename,
    row_count: rows.length,
    columns,
    suggested_preset: suggestedPreset,
    presets: PROVIDER_MAPPING_PRESETS,
    sample_rows: sampleRows,
  };
}

function safeFloat(val: unknown, fallback: number | null = null): number | null {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function hashStringInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 10000;
}

async function mergeIntoOverlay(env: Env, addition: Omit<OverlayPayload, "version">): Promise<DatasetStore> {
  const existing = (await env.PITCHLAB_KV.get<OverlayPayload>("overlay:data", "json")) || {
    version: "",
    matches: [],
    teams: [],
    players: [],
    lineups: [],
    events: [],
  };

  const mergeByKey = <T>(cur: T[], nxt: T[], keyFn: (item: T) => string | number): T[] => {
    const map = new Map<string | number, T>();
    for (const item of cur) map.set(keyFn(item), item);
    for (const item of nxt) map.set(keyFn(item), item);
    return Array.from(map.values());
  };

  const updated: OverlayPayload = {
    version: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    matches: mergeByKey(existing.matches, addition.matches, (m) => m.match_id),
    teams: mergeByKey(existing.teams, addition.teams, (t) => t.team_id),
    players: mergeByKey(existing.players, addition.players, (p) => p.player_id),
    lineups: mergeByKey(existing.lineups, addition.lineups, (l) => `${l.match_id}:${l.player_id}`),
    events: mergeByKey(existing.events, addition.events, (e) => e.event_id),
  };

  await env.PITCHLAB_KV.put("overlay:data", JSON.stringify(updated), { expirationTtl: 86400 });
  invalidateDatasetCache();
  return getDatasetStore(env);
}

export async function ingestUploadedCsv(
  env: Env,
  store: DatasetStore,
  fileBytes: ArrayBuffer,
  filename: string,
  columnMapping: Record<string, string>,
  coordSystem = "100x100",
  dataSource = "custom_upload",
  seasonName = "2024/2025",
  competitionName = "Imported Feed"
): Promise<{ ingest: Record<string, unknown>; store: DatasetStore }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".parquet") || lower.endsWith(".pq")) {
    throw new Error(
      "Parquet binary parsing is only available on the local FastAPI backend. Please export as .csv for cloud Worker ingestion."
    );
  }
  if (!lower.endsWith(".csv")) {
    throw new Error(`Unsupported file format for '${filename}'. Upload .csv or .parquet files.`);
  }

  const text = new TextDecoder("utf-8").decode(fileBytes);
  const { rows } = parseCsvText(text);

  const existingTeams = new Map<string, number>();
  let maxTeamId = 100;
  for (const t of store.teams) {
    existingTeams.set(t.team_name.toLowerCase(), t.team_id);
    if (t.team_id > maxTeamId) maxTeamId = t.team_id;
  }
  let nextTeamId = maxTeamId + 1;

  const existingPlayers = new Map<string, number>();
  let maxPlayerId = 5000;
  for (const p of store.players) {
    existingPlayers.set(p.player_name.toLowerCase(), p.player_id);
    if (p.player_id > maxPlayerId) maxPlayerId = p.player_id;
  }
  let nextPlayerId = maxPlayerId + 1;

  const eventsToInsert: EventRow[] = [];
  const newTeams: TeamRow[] = [];
  const newPlayers: PlayerRow[] = [];
  const matchGoals = new Map<number, Record<string, number>>();
  const matchTeams = new Map<number, Array<[number, string]>>();

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const getCol = (canon: string, fallback: unknown = null) => {
      const src = columnMapping[canon];
      if (src && row[src] !== undefined && row[src] !== "") return row[src];
      return fallback;
    };

    const rawMatchId = getCol("match_id", 990001);
    const parsedMatch = Number(rawMatchId);
    const matchId = Number.isInteger(parsedMatch) ? parsedMatch : 990000 + hashStringInt(String(rawMatchId));

    const teamName = String(getCol("team_name", "Imported FC")).trim() || "Imported FC";
    if (!existingTeams.has(teamName.toLowerCase())) {
      existingTeams.set(teamName.toLowerCase(), nextTeamId);
      newTeams.push({
        team_id: nextTeamId,
        team_name: teamName,
        country: "Imported",
        gender: "male",
        manager_name: "Head Coach",
        primary_formation: "4-3-3",
      });
      nextTeamId += 1;
    }
    const teamId = existingTeams.get(teamName.toLowerCase())!;

    const playerName = String(getCol("player_name", "Unknown Player")).trim() || "Unknown Player";
    if (!existingPlayers.has(playerName.toLowerCase())) {
      existingPlayers.set(playerName.toLowerCase(), nextPlayerId);
      const parts = playerName.split(/\s+/);
      newPlayers.push({
        player_id: nextPlayerId,
        player_name: playerName,
        nickname: parts[parts.length - 1] || playerName,
        team_id: teamId,
        team_name: teamName,
        country: "Imported",
        primary_position: "Midfielder",
        position_group: "MF",
      });
      nextPlayerId += 1;
    }
    const playerId = existingPlayers.get(playerName.toLowerCase())!;

    let rawType = String(getCol("event_type", "Pass")).trim();
    let rawOutcome = String(getCol("outcome", "Complete")).trim();
    const lt = rawType.toLowerCase();
    if (["goal", "savedshot", "missedshots", "shotonpost", "blockedshot"].includes(lt)) {
      if (lt === "goal") rawOutcome = "Goal";
      else if (lt === "savedshot") rawOutcome = "Saved";
      else if (lt === "blockedshot") rawOutcome = "Blocked";
      else rawOutcome = "Off T";
      rawType = "Shot";
    }

    const rawX = safeFloat(getCol("x"), 60.0);
    const rawY = safeFloat(getCol("y"), 40.0);
    const rawEx = safeFloat(getCol("end_x"), null);
    const rawEy = safeFloat(getCol("end_y"), null);

    const [x120, y80, x105, y105] = fromSourceCoords(rawX, rawY, coordSystem);
    const [ex120, ey80, ex105, ey105] = fromSourceCoords(rawEx, rawEy, coordSystem);

    const xg = safeFloat(getCol("xg"), 0.0) ?? 0.0;
    const minRaw = String(getCol("minute", "1"));
    const minParsed = parseInt(minRaw.split(":")[0], 10);
    const minute = Number.isFinite(minParsed) ? minParsed : 1;

    if (!matchTeams.has(matchId)) matchTeams.set(matchId, []);
    const mt = matchTeams.get(matchId)!;
    if (!mt.some(([tid, tnm]) => tid === teamId && tnm === teamName)) {
      mt.push([teamId, teamName]);
    }
    if (!matchGoals.has(matchId)) matchGoals.set(matchId, {});
    if (rawType === "Shot" && rawOutcome.toLowerCase() === "goal") {
      const mg = matchGoals.get(matchId)!;
      mg[teamName] = (mg[teamName] || 0) + 1;
    }

    let isProgPass = false;
    let isBox = false;
    if (
      rawType === "Pass" &&
      ["complete", "1", "true", "accurate"].includes(rawOutcome.toLowerCase()) &&
      ex105 !== null &&
      ey105 !== null &&
      x105 !== null &&
      y105 !== null
    ) {
      const d0 = Math.hypot(105.0 - x105, 34.0 - y105);
      const d1 = Math.hypot(105.0 - ex105, 34.0 - ey105);
      isProgPass = d0 - d1 >= 10.0;
      isBox = ex105 >= 88.5 && ey105 >= 13.84 && ey105 <= 54.16 && x105 < 88.5;
      rawOutcome = "Complete";
    }

    const eventId = String(getCol("event_id", `imp_${matchId}_${rowIdx}`));
    const passLen = roundHalfToEven(
      Math.hypot((ex105 ?? x105 ?? 0) - (x105 ?? 0), (ey105 ?? y105 ?? 0) - (y105 ?? 0)),
      2
    );

    eventsToInsert.push({
      event_id: eventId,
      match_id: matchId,
      index_num: rowIdx + 1,
      period: minute <= 45 ? 1 : 2,
      timestamp: `${String(minute).padStart(2, "0")}:00.000`,
      minute,
      second: 0,
      possession: Math.floor(rowIdx / 3) + 1,
      possession_team_id: teamId,
      possession_team_name: teamName,
      team_id: teamId,
      team_name: teamName,
      player_id: playerId,
      player_name: playerName,
      position_name: "Imported",
      event_type: rawType,
      outcome: rawOutcome,
      x: x120 ?? 60,
      y: y80 ?? 40,
      end_x: ex120,
      end_y: ey80,
      x_105: x105 ?? 52.5,
      y_105: y105 ?? 34,
      end_x_105: ex105,
      end_y_105: ey105,
      xg,
      pass_length: passLen,
      pass_angle: 0.0,
      pass_height: "Ground Pass",
      pass_recipient_id: null,
      pass_recipient_name: null,
      is_key_pass: false,
      is_assist: false,
      is_progressive_pass: isProgPass,
      is_box_entry: isBox,
      is_progressive_carry: false,
      carry_distance: 0.0,
      is_defensive_action: ["Tackle", "Interception", "Pressure", "Duel", "Ball Recovery"].includes(rawType),
      is_high_turnover: ["Interception", "Ball Recovery"].includes(rawType) && (x105 ?? 0.0) >= 65.0,
      is_counterpress: false,
      under_pressure: false,
      has_freeze_frame: false,
      shot_body_part: rawType === "Shot" ? "Right Foot" : null,
      shot_type: rawType === "Shot" ? "Open Play" : null,
      shot_technique: rawType === "Shot" ? "Normal" : null,
      tactical_formation: "4-3-3",
      match_state: "drawing",
    });
  }

  const newMatches: MatchRow[] = [];
  for (const [mid, tlist] of matchTeams.entries()) {
    if (store.matchesById.has(mid)) continue;
    const [hId, hName] = tlist[0];
    const [aId, aName] = tlist.length > 1 ? tlist[1] : [hId + 900, "Imported Opponent"];
    const mg = matchGoals.get(mid) || {};
    newMatches.push({
      match_id: mid,
      competition_id: 999,
      competition_name: competitionName,
      season_id: 999,
      season_name: seasonName,
      match_date: "2025-01-15",
      match_week: 1,
      home_team_id: hId,
      home_team_name: hName,
      away_team_id: aId,
      away_team_name: aName,
      home_score: mg[hName] || 0,
      away_score: mg[aName] || 0,
      home_manager: "Head Coach",
      away_manager: "Head Coach",
      home_formation: "4-3-3",
      away_formation: "4-3-3",
      stadium_name: "Imported Stadium",
      referee_name: "Match Official",
      data_source: dataSource,
      coord_system: coordSystem,
    });
  }

  const updatedStore = await mergeIntoOverlay(env, {
    matches: newMatches,
    teams: newTeams,
    players: newPlayers,
    lineups: [],
    events: eventsToInsert,
  });

  return {
    ingest: {
      status: "ok",
      data_source: dataSource,
      coord_system: coordSystem,
      events_ingested: eventsToInsert.length,
      new_matches_created: newMatches.length,
      new_teams_created: newTeams.length,
      new_players_created: newPlayers.length,
    },
    store: updatedStore,
  };
}

function isProgressivePass105(x0: number, y0: number, x1: number, y1: number): boolean {
  const startGoalDist = Math.hypot(105.0 - x0, 34.0 - y0);
  const endGoalDist = Math.hypot(105.0 - x1, 34.0 - y1);
  if (x1 >= 88.5 && y1 >= 13.84 && y1 <= 54.16 && x0 < 88.5) return true;
  if (startGoalDist - endGoalDist >= 10.0) return true;
  return false;
}

export async function ingestStatsbomb(
  env: Env,
  store: DatasetStore,
  params: {
    mode: string;
    reset: boolean;
    competition_id: number;
    season_id: number;
    max_matches: number;
  }
): Promise<{ ingest: Record<string, unknown>; store: DatasetStore }> {
  if (params.mode !== "github") {
    if (params.reset) {
      await env.PITCHLAB_KV.delete("overlay:data");
      invalidateDatasetCache();
    }
    const freshStore = await getDatasetStore(env);
    return {
      ingest: {
        status: "ok",
        source: "statsbomb_canonical_open_data",
        matches_loaded: freshStore.matches.length,
        teams_loaded: freshStore.teams.length,
        players_loaded: freshStore.players.length,
        lineups_loaded: freshStore.lineups.length,
        events_loaded: freshStore.events.length,
      },
      store: freshStore,
    };
  }

  const mResp = await fetch(`${STATSBOMB_BASE_URL}/matches/${params.competition_id}/${params.season_id}.json`);
  if (!mResp.ok) {
    throw new Error(`StatsBomb matches fetch failed (${mResp.status})`);
  }
  const allMatches = (await mResp.json()) as Array<Record<string, any>>;
  const rawMatches = allMatches.slice(0, params.max_matches);

  const matchesRows: MatchRow[] = [];
  const teamsMap = new Map<number, TeamRow>();
  const playersMap = new Map<number, PlayerRow>();
  const lineupsRows: LineupRow[] = [];
  const eventsRows: EventRow[] = [];

  for (const m of rawMatches) {
    const matchId = Number(m.match_id);
    const hTeam = m.home_team;
    const aTeam = m.away_team;
    const hId = Number(hTeam.home_team_id);
    const aId = Number(aTeam.away_team_id);
    const hName = String(hTeam.home_team_name);
    const aName = String(aTeam.away_team_name);
    const hMgr = hTeam.managers?.[0]?.name || "Unknown Manager";
    const aMgr = aTeam.managers?.[0]?.name || "Unknown Manager";

    teamsMap.set(hId, {
      team_id: hId,
      team_name: hName,
      country: hTeam.country?.name || "Unknown",
      gender: hTeam.home_team_gender || "male",
      manager_name: hMgr,
      primary_formation: "4-3-3",
    });
    teamsMap.set(aId, {
      team_id: aId,
      team_name: aName,
      country: aTeam.country?.name || "Unknown",
      gender: aTeam.away_team_gender || "male",
      manager_name: aMgr,
      primary_formation: "4-3-3",
    });

    const [lResp, eResp] = await Promise.all([
      fetch(`${STATSBOMB_BASE_URL}/lineups/${matchId}.json`),
      fetch(`${STATSBOMB_BASE_URL}/events/${matchId}.json`),
    ]);
    if (!lResp.ok) throw new Error(`StatsBomb lineups fetch failed (${lResp.status})`);
    if (!eResp.ok) throw new Error(`StatsBomb events fetch failed (${eResp.status})`);

    const lineupJson = (await lResp.json()) as Array<Record<string, any>>;
    for (const teamL of lineupJson) {
      const tid = Number(teamL.team_id);
      const tname = String(teamL.team_name);
      for (const p of teamL.lineup || []) {
        const pid = Number(p.player_id);
        const pname = String(p.player_name);
        const positions = (p.positions || []) as Array<Record<string, any>>;
        const posName = positions.length ? String(positions[0].position) : "Substitute";
        let mOn = 0;
        let mOff = 90;
        let isStarter = false;
        if (positions.length) {
          isStarter = (positions[0].start_reason || "Starting XI") === "Starting XI";
          const fromStr = String(positions[0].from || "00:00");
          mOn = fromStr.includes(":") ? parseInt(fromStr.split(":")[0], 10) : 0;
          const toStr = positions[positions.length - 1].to;
          mOff = toStr && String(toStr).includes(":") ? parseInt(String(toStr).split(":")[0], 10) : 90;
        } else {
          mOn = 0;
          mOff = 0;
        }
        const mins = Math.max(0, mOff - mOn);
        const posGrp = posName.includes("Goalkeeper")
          ? "GK"
          : posName.includes("Back") || posName.includes("Defender")
            ? "DF"
            : posName.includes("Wing") || posName.includes("Forward") || posName.includes("Striker")
              ? "FW"
              : "MF";

        playersMap.set(pid, {
          player_id: pid,
          player_name: pname,
          nickname: p.player_nickname ?? null,
          team_id: tid,
          team_name: tname,
          country: p.country?.name || "Unknown",
          primary_position: posName,
          position_group: posGrp,
        });
        lineupsRows.push({
          match_id: matchId,
          team_id: tid,
          team_name: tname,
          player_id: pid,
          player_name: pname,
          jersey_number: Number(p.jersey_number || 0),
          position_name: posName,
          is_starter: isStarter,
          minute_on: mOn,
          minute_off: mOff,
          minutes_played: mins,
          tactical_formation: "4-3-3",
        });
      }
    }

    const rawEvents = (await eResp.json()) as Array<Record<string, any>>;
    let hG = 0;
    let aG = 0;
    let hForm = "4-3-3";
    let aForm = "4-3-3";

    for (const ev of rawEvents) {
      const etype = String(ev.type?.name || "Other");
      const tid = Number(ev.team?.id ?? hId);
      const tname = String(ev.team?.name || hName);
      if (etype === "Starting XI") {
        const formRaw = String(ev.tactics?.formation || "433");
        const formStr = /^\d+$/.test(formRaw) ? formRaw.split("").join("-") : formRaw;
        if (tid === hId) hForm = formStr;
        else aForm = formStr;
        continue;
      }

      const loc = ev.location as number[] | undefined;
      if (!loc || loc.length < 2) continue;
      const x = Number(loc[0]);
      const y = Number(loc[1]);
      const [x105Raw, y105Raw] = to105x68(x, y);
      const x105 = x105Raw ?? 0;
      const y105 = y105Raw ?? 0;

      let endX: number | null = null;
      let endY: number | null = null;
      let ex105: number | null = null;
      let ey105: number | null = null;
      let outcome = "Complete";
      let xg = 0.0;
      let pLen = 0.0;
      let pAng = 0.0;
      let pHeight: string | null = null;
      let recipId: number | null = null;
      let recipName: string | null = null;
      let isKp = false;
      let isAssist = false;
      let isProg = false;
      let isBox = false;
      let isProgC = false;
      let cDist = 0.0;
      let isDef = false;
      let isHt = false;
      let sbBody: string | null = null;
      let sbType: string | null = null;
      let sbTech: string | null = null;

      if (etype === "Pass") {
        const pObj = ev.pass || {};
        const endLoc = pObj.end_location as number[] | undefined;
        if (endLoc && endLoc.length >= 2) {
          endX = Number(endLoc[0]);
          endY = Number(endLoc[1]);
          [ex105, ey105] = to105x68(endX, endY);
          if (ex105 !== null && ey105 !== null) {
            isProg = isProgressivePass105(x105, y105, ex105, ey105);
            isBox = ex105 >= 88.5 && ey105 >= 13.84 && ey105 <= 54.16 && x105 < 88.5;
          }
        }
        outcome = pObj.outcome?.name || "Complete";
        if (outcome !== "Complete") {
          isProg = false;
          isBox = false;
        }
        pLen = Number(pObj.length || 0);
        pAng = Number(pObj.angle || 0);
        pHeight = pObj.height?.name ?? null;
        if (pObj.recipient?.id) {
          recipId = Number(pObj.recipient.id);
          recipName = pObj.recipient.name ?? null;
        }
        isKp = Boolean(pObj.shot_assist);
        isAssist = Boolean(pObj.goal_assist);
      } else if (etype === "Carry") {
        const cObj = ev.carry || {};
        const endLoc = cObj.end_location as number[] | undefined;
        if (endLoc && endLoc.length >= 2) {
          endX = Number(endLoc[0]);
          endY = Number(endLoc[1]);
          [ex105, ey105] = to105x68(endX, endY);
          if (ex105 !== null && ey105 !== null) {
            cDist = roundHalfToEven(Math.hypot(ex105 - x105, ey105 - y105), 2);
            isProgC = ex105 - x105 >= 8.0 || (ex105 >= 88.5 && x105 < 88.5);
            isBox = ex105 >= 88.5 && ey105 >= 13.84 && ey105 <= 54.16 && x105 < 88.5;
          }
        }
      } else if (etype === "Shot") {
        const sObj = ev.shot || {};
        const endLoc = sObj.end_location as number[] | undefined;
        if (endLoc && endLoc.length >= 2) {
          endX = Number(endLoc[0]);
          endY = Number(endLoc[1]);
          [ex105, ey105] = to105x68(endX, endY);
        }
        xg = Number(sObj.statsbomb_xg || 0);
        outcome = sObj.outcome?.name || "Off T";
        sbBody = sObj.body_part?.name ?? null;
        sbType = sObj.type?.name ?? null;
        sbTech = sObj.technique?.name ?? null;
      } else if (["Pressure", "Duel", "Interception", "Block", "Clearance", "Ball Recovery"].includes(etype)) {
        isDef = true;
        outcome = ev[etype.toLowerCase()]?.outcome?.name || "Complete";
        if (["Interception", "Ball Recovery", "Duel"].includes(etype) && x105 >= 65.0) {
          isHt = true;
        }
      }

      const diff = tid === hId ? hG - aG : aG - hG;
      const mState = diff > 0 ? "winning" : diff < 0 ? "losing" : "drawing";
      if (etype === "Shot" && outcome === "Goal") {
        if (tid === hId) hG += 1;
        else aG += 1;
      }

      const pInfo = ev.player || {};
      eventsRows.push({
        event_id: String(ev.id),
        match_id: matchId,
        index_num: Number(ev.index || 0),
        period: Number(ev.period || 1),
        timestamp: String(ev.timestamp || "00:00:00.000"),
        minute: Number(ev.minute || 0),
        second: Number(ev.second || 0),
        possession: Number(ev.possession || 0),
        possession_team_id: Number(ev.possession_team?.id ?? tid),
        possession_team_name: String(ev.possession_team?.name || tname),
        team_id: tid,
        team_name: tname,
        player_id: pInfo.id ? Number(pInfo.id) : null,
        player_name: pInfo.name ?? null,
        position_name: ev.position?.name ?? null,
        event_type: etype,
        outcome,
        x,
        y,
        end_x: endX,
        end_y: endY,
        x_105: x105,
        y_105: y105,
        end_x_105: ex105,
        end_y_105: ey105,
        xg,
        pass_length: pLen,
        pass_angle: pAng,
        pass_height: pHeight,
        pass_recipient_id: recipId,
        pass_recipient_name: recipName,
        is_key_pass: isKp,
        is_assist: isAssist,
        is_progressive_pass: isProg,
        is_box_entry: isBox,
        is_progressive_carry: isProgC,
        carry_distance: cDist,
        is_defensive_action: isDef,
        is_high_turnover: isHt,
        is_counterpress: Boolean(ev.counterpress),
        under_pressure: Boolean(ev.under_pressure),
        has_freeze_frame: Boolean(ev.shot?.freeze_frame),
        shot_body_part: sbBody,
        shot_type: sbType,
        shot_technique: sbTech,
        tactical_formation: tid === hId ? hForm : aForm,
        match_state: mState,
      });
    }

    matchesRows.push({
      match_id: matchId,
      competition_id: Number(m.competition.competition_id),
      competition_name: String(m.competition.competition_name),
      season_id: Number(m.season.season_id),
      season_name: String(m.season.season_name),
      match_date: String(m.match_date),
      match_week: Number(m.match_week || 1),
      home_team_id: hId,
      home_team_name: hName,
      away_team_id: aId,
      away_team_name: aName,
      home_score: Number(m.home_score),
      away_score: Number(m.away_score),
      home_manager: hMgr,
      away_manager: aMgr,
      home_formation: hForm,
      away_formation: aForm,
      stadium_name: m.stadium?.name ?? null,
      referee_name: m.referee?.name ?? null,
      data_source: "statsbomb_open_data_github",
      coord_system: "120x80",
    });
  }

  const updatedStore = await mergeIntoOverlay(env, {
    matches: matchesRows,
    teams: Array.from(teamsMap.values()),
    players: Array.from(playersMap.values()),
    lineups: lineupsRows,
    events: eventsRows,
  });

  return {
    ingest: {
      status: "ok",
      source: "statsbomb_open_data_github",
      matches_loaded: matchesRows.length,
      events_loaded: eventsRows.length,
      lineups_loaded: lineupsRows.length,
    },
    store: updatedStore,
  };
}

interface ProviderDescriptor {
  provider_id: string;
  display_name: string;
  base_url: string;
  coord_system: string;
  is_configured: boolean;
  api_key_masked: string;
  capabilities: string[];
}

const DEFAULT_PROVIDERS: ProviderDescriptor[] = [
  {
    provider_id: "statsbomb_open",
    display_name: "StatsBomb Open Data (GitHub)",
    base_url: "https://raw.githubusercontent.com/statsbomb/open-data/master/data",
    coord_system: "120x80",
    is_configured: true,
    api_key_masked: "",
    capabilities: ["events", "xg", "lineups", "formations"],
  },
  {
    provider_id: "statsbomb_iq",
    display_name: "StatsBomb IQ Live API",
    base_url: "https://data.statsbombservices.com/api/v4",
    coord_system: "120x80",
    is_configured: false,
    api_key_masked: "",
    capabilities: ["events", "xg", "360_freeze_frames", "obv"],
  },
  {
    provider_id: "wyscout_v3",
    display_name: "Hudl Wyscout API v3",
    base_url: "https://apirest.wyscout.com/v3",
    coord_system: "100x100",
    is_configured: false,
    api_key_masked: "",
    capabilities: ["events", "xg", "player_contracts"],
  },
  {
    provider_id: "opta_feed",
    display_name: "Stats Perform Opta Event Feed",
    base_url: "https://api.performfeeds.com/soccerdata",
    coord_system: "100x100",
    is_configured: false,
    api_key_masked: "",
    capabilities: ["events", "xg", "xa", "formations"],
  },
];

export async function listProviders(env: Env): Promise<ProviderDescriptor[]> {
  const saved = await env.PITCHLAB_KV.get<Record<string, Partial<ProviderDescriptor>>>("providers:config", "json");
  return DEFAULT_PROVIDERS.map((p) => {
    const ov = saved?.[p.provider_id];
    return ov ? { ...p, ...ov } : { ...p };
  });
}

export async function configureProvider(
  env: Env,
  providerId: string,
  apiKey: string,
  baseUrl?: string | null
): Promise<{ health: Record<string, unknown>; providers: ProviderDescriptor[] }> {
  const baseDef = DEFAULT_PROVIDERS.find((p) => p.provider_id === providerId);
  if (!baseDef) {
    throw new Error(`Unknown provider '${providerId}'.`);
  }

  const saved = (await env.PITCHLAB_KV.get<Record<string, Partial<ProviderDescriptor>>>("providers:config", "json")) || {};
  const cleaned = apiKey.trim();
  const masked =
    cleaned.length >= 8 ? `${cleaned.slice(0, 4)}••••${cleaned.slice(-3)}` : cleaned ? "••••" : "";
  const effectiveUrl = baseUrl ? baseUrl.trim() : saved[providerId]?.base_url || baseDef.base_url;
  const isConfigured = Boolean(cleaned) || providerId === "statsbomb_open";

  saved[providerId] = {
    base_url: effectiveUrl,
    is_configured: isConfigured,
    api_key_masked: masked,
  };
  await env.PITCHLAB_KV.put("providers:config", JSON.stringify(saved), { expirationTtl: 86400 });

  let health: Record<string, unknown>;
  if (!cleaned && providerId !== "statsbomb_open") {
    health = {
      provider_id: providerId,
      status: "not_configured",
      message: "API key required to activate live feed.",
    };
  } else if (providerId === "statsbomb_open") {
    try {
      const r = await fetch(`${effectiveUrl}/competitions.json`);
      health = {
        provider_id: providerId,
        status: r.status === 200 ? "connected" : "error",
        http_status: r.status,
      };
    } catch (err) {
      health = {
        provider_id: providerId,
        status: "offline",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    health = {
      provider_id: providerId,
      status: "configured_ready",
      message: `Credentials stored for ${baseDef.display_name} (${baseDef.coord_system} native grid).`,
    };
  }

  const providers = await listProviders(env);
  return { health, providers };
}
