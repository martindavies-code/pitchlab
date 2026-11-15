"""Export full DuckDB dataset into chunked Cloudflare KV bulk JSON without truncation."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
import duckdb

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "pitchlab.duckdb"
OUT_DIR = Path(__file__).resolve().parents[1] / "data"

STRING_COLS = {
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
}


def fetch_table_dicts(conn: duckdb.DuckDBPyConnection, table: str) -> list[dict[str, Any]]:
    cur = conn.execute(f"SELECT * FROM {table}")
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        item: dict[str, Any] = {}
        for c, v in zip(cols, r):
            if type(v).__name__ == "date":
                item[c] = v.isoformat()
            else:
                item[c] = v
        out.append(item)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not DB_PATH.exists():
        import sys
        sys.path.insert(0, str(ROOT))
        from backend.adapters.statsbomb_loader import ingest_default_statsbomb_dataset
        from backend.db.connection import db_session
        with db_session() as init_conn:
            ingest_default_statsbomb_dataset(init_conn, reset=True)
    conn = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        matches = fetch_table_dicts(conn, "matches")
        teams = fetch_table_dicts(conn, "teams")
        players = fetch_table_dicts(conn, "players")
        lineups = fetch_table_dicts(conn, "lineups")

        ev_cur = conn.execute("SELECT * FROM events ORDER BY match_id, index_num")
        ev_cols = [d[0] for d in ev_cur.description]
        ev_rows = ev_cur.fetchall()
    finally:
        conn.close()

    vocab: list[str] = []
    vmap: dict[str, int] = {}

    def intern(val: str | None) -> int | None:
        if val is None:
            return None
        if val not in vmap:
            vmap[val] = len(vocab)
            vocab.append(val)
        return vmap[val]

    compact_events: list[list[Any]] = []
    for r in ev_rows:
        cr: list[Any] = []
        for c, v in zip(ev_cols, r):
            if c in STRING_COLS:
                cr.append(intern(v))
            elif isinstance(v, bool):
                cr.append(1 if v else 0)
            else:
                cr.append(v)
        compact_events.append(cr)

    chunk_size = 8000
    num_chunks = math.ceil(len(compact_events) / chunk_size)

    kv_entries: list[dict[str, str]] = [
        {
            "key": "dataset:manifest",
            "value": json.dumps(
                {
                    "version": 1,
                    "eventChunks": num_chunks,
                    "eventColumns": ev_cols,
                    "stringCols": sorted(STRING_COLS),
                    "counts": {
                        "matches": len(matches),
                        "teams": len(teams),
                        "players": len(players),
                        "lineups": len(lineups),
                        "events": len(compact_events),
                    },
                },
                separators=(",", ":"),
            ),
        },
        {
            "key": "dataset:core",
            "value": json.dumps(
                {
                    "matches": matches,
                    "teams": teams,
                    "players": players,
                    "lineups": lineups,
                },
                separators=(",", ":"),
            ),
        },
        {
            "key": "dataset:events:vocab",
            "value": json.dumps(vocab, separators=(",", ":")),
        },
    ]

    for idx in range(num_chunks):
        slice_rows = compact_events[idx * chunk_size : (idx + 1) * chunk_size]
        kv_entries.append(
            {
                "key": f"dataset:events:{idx}",
                "value": json.dumps(slice_rows, separators=(",", ":")),
            }
        )

    bulk_path = OUT_DIR / "kv-bulk.json"
    bulk_path.write_text(json.dumps(kv_entries, separators=(",", ":")), encoding="utf-8")

    print(f"Exported {len(kv_entries)} KV entries to {bulk_path} ({bulk_path.stat().st_size / (1024*1024):.2f} MB)")
    for entry in kv_entries:
        print(f"  {entry['key']}: {len(entry['value'].encode('utf-8')) / 1024:.1f} KB")


if __name__ == "__main__":
    main()
