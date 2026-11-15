"""DuckDB connection management for PitchLab Studio."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import duckdb

from backend.db.schema import init_schema

DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "pitchlab.duckdb"


def get_db_path() -> Path:
    """Resolve the active DuckDB file path from environment or default workspace path."""
    env_path = os.environ.get("PITCHLAB_DB_PATH")
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def get_connection(read_only: bool = False, db_path: Path | str | None = None) -> duckdb.DuckDBPyConnection:
    """Open a DuckDB connection and ensure canonical tables exist when writable."""
    target = Path(db_path) if db_path is not None else get_db_path()
    if str(target) != ":memory:":
        target.parent.mkdir(parents=True, exist_ok=True)
    conn = duckdb.connect(str(target), read_only=read_only)
    if not read_only:
        init_schema(conn)
    return conn


@contextmanager
def db_session(read_only: bool = False, db_path: Path | str | None = None) -> Iterator[duckdb.DuckDBPyConnection]:
    """Context manager yielding an initialized DuckDB connection and closing cleanly."""
    conn = get_connection(read_only=read_only, db_path=db_path)
    try:
        yield conn
    finally:
        conn.close()
