"""FastAPI backend entrypoint for PitchLab Studio."""

from __future__ import annotations

from contextlib import asynccontextmanager
import json
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.adapters.file_importer import (
    PROVIDER_MAPPING_PRESETS,
    ingest_mapped_dataframe,
    preview_uploaded_file,
    read_uploaded_dataframe,
)
from backend.adapters.rest_provider import configure_provider, list_providers
from backend.adapters.statsbomb_loader import (
    ingest_default_statsbomb_dataset,
    ingest_live_statsbomb_github,
)
from backend.agent.workflow import (
    WORKFLOW_SESSIONS,
    approve_stage_2_build_plan,
    approve_stage_3_execute_and_verify,
    approve_stage_4_render,
    confirm_stage_1_and_check_feasibility,
    override_assumptions_and_rerun,
    start_workflow_session,
)
from backend.analytics.conclusion import build_analysis_conclusion
from backend.analytics.modules import DEFAULT_ASSUMPTIONS, execute_module
from backend.analytics.verification import run_automated_verification
from backend.db.connection import db_session
from backend.db.schema import inspect_database_capabilities


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Initialize DuckDB canonical schema and default StatsBomb dataset if empty."""
    with db_session() as conn:
        caps = inspect_database_capabilities(conn)
        if caps["table_counts"]["matches"] == 0:
            ingest_default_statsbomb_dataset(conn, reset=True)
    yield


app = FastAPI(
    title="PitchLab Studio API",
    version="1.0.0",
    description="Local-first football analytics engine and gated 5-stage agentic workflow API.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WorkflowStartRequest(BaseModel):
    prompt: str = Field(..., min_length=2)


class Stage1ConfirmRequest(BaseModel):
    clarifications: dict[str, Any] = Field(default_factory=dict)


class Stage3ApproveRequest(BaseModel):
    param_edits: dict[str, Any] = Field(default_factory=dict)


class OverrideAssumptionsRequest(BaseModel):
    assumptions: dict[str, Any] = Field(default_factory=dict)


class ModuleRunRequest(BaseModel):
    overrides: dict[str, Any] = Field(default_factory=dict)


class StatsBombIngestRequest(BaseModel):
    mode: str = "canonical"  # 'canonical' | 'github'
    reset: bool = True
    competition_id: int = 2
    season_id: int = 27
    max_matches: int = 3


class ProviderConfigureRequest(BaseModel):
    provider_id: str
    api_key: str
    base_url: str | None = None


@app.get("/api/health")
def health() -> dict[str, Any]:
    with db_session() as conn:
        caps = inspect_database_capabilities(conn)
    return {
        "status": "ok",
        "table_counts": caps["table_counts"],
        "seasons": caps["seasons"],
    }


@app.get("/api/schema/capabilities")
def get_capabilities() -> dict[str, Any]:
    with db_session() as conn:
        return inspect_database_capabilities(conn)


@app.get("/api/defaults")
def get_defaults() -> dict[str, Any]:
    return {
        "assumptions": DEFAULT_ASSUMPTIONS,
        "mapping_presets": PROVIDER_MAPPING_PRESETS,
    }


# --- 5-Stage Gated Agentic Workflow Endpoints ---

@app.post("/api/workflow/start")
def api_workflow_start(req: WorkflowStartRequest) -> dict[str, Any]:
    with db_session() as conn:
        return start_workflow_session(conn, req.prompt)


@app.get("/api/workflow/{session_id}")
def api_workflow_get(session_id: str) -> dict[str, Any]:
    if session_id not in WORKFLOW_SESSIONS:
        raise HTTPException(status_code=404, detail="Workflow session not found")
    return WORKFLOW_SESSIONS[session_id]


@app.post("/api/workflow/{session_id}/stage-1-confirm")
def api_stage_1_confirm(session_id: str, req: Stage1ConfirmRequest) -> dict[str, Any]:
    with db_session() as conn:
        try:
            return confirm_stage_1_and_check_feasibility(conn, session_id, req.clarifications)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflow/{session_id}/stage-2-approve")
def api_stage_2_approve(session_id: str) -> dict[str, Any]:
    with db_session() as conn:
        try:
            return approve_stage_2_build_plan(conn, session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflow/{session_id}/stage-3-approve")
def api_stage_3_approve(session_id: str, req: Stage3ApproveRequest) -> dict[str, Any]:
    with db_session() as conn:
        try:
            return approve_stage_3_execute_and_verify(conn, session_id, req.param_edits)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflow/{session_id}/stage-4-approve")
def api_stage_4_approve(session_id: str) -> dict[str, Any]:
    with db_session() as conn:
        try:
            return approve_stage_4_render(conn, session_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflow/{session_id}/override-assumptions")
def api_override_assumptions(session_id: str, req: OverrideAssumptionsRequest) -> dict[str, Any]:
    with db_session() as conn:
        try:
            return override_assumptions_and_rerun(conn, session_id, req.assumptions)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc


# --- Direct Standalone Module Execution Endpoints ---

@app.post("/api/modules/{module_id}/run")
def api_run_module(module_id: str, req: ModuleRunRequest) -> dict[str, Any]:
    with db_session() as conn:
        try:
            result = execute_module(conn, module_id, req.overrides)
            verification = run_automated_verification(conn, module_id, result["assumptions"], result)
            result["conclusion"] = build_analysis_conclusion(result, verification=verification)
            return {
                "module_id": module_id,
                "result": result,
                "verification": verification,
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


# --- Data Layer & Plug-and-Play Adapters ---

@app.post("/api/adapters/statsbomb/ingest")
def api_ingest_statsbomb(req: StatsBombIngestRequest) -> dict[str, Any]:
    with db_session() as conn:
        if req.mode == "github":
            summary = ingest_live_statsbomb_github(
                conn,
                competition_id=req.competition_id,
                season_id=req.season_id,
                max_matches=req.max_matches,
            )
        else:
            summary = ingest_default_statsbomb_dataset(conn, reset=req.reset)
        caps = inspect_database_capabilities(conn)
        return {"ingest": summary, "capabilities": caps}


@app.post("/api/adapters/upload-preview")
async def api_upload_preview(file: UploadFile = File(...)) -> dict[str, Any]:
    content = await file.read()
    try:
        return preview_uploaded_file(content, file.filename or "upload.csv")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/adapters/upload-ingest")
async def api_upload_ingest(
    file: UploadFile = File(...),
    mapping_json: str = Form(...),
    coord_system: str = Form("100x100"),
    data_source: str = Form("custom_upload"),
    season_name: str = Form("2024/2025"),
    competition_name: str = Form("Imported Feed"),
) -> dict[str, Any]:
    content = await file.read()
    try:
        df = read_uploaded_dataframe(content, file.filename or "upload.csv")
        mapping = json.loads(mapping_json)
        with db_session() as conn:
            ingest_res = ingest_mapped_dataframe(
                conn,
                df,
                column_mapping=mapping,
                coord_system=coord_system,
                data_source=data_source,
                season_name=season_name,
                competition_name=competition_name,
            )
            caps = inspect_database_capabilities(conn)
        return {"ingest": ingest_res, "capabilities": caps}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/adapters/providers")
def api_list_providers() -> dict[str, Any]:
    return {"providers": list_providers()}


@app.post("/api/adapters/providers/configure")
def api_configure_provider(req: ProviderConfigureRequest) -> dict[str, Any]:
    try:
        health_res = configure_provider(req.provider_id, req.api_key, req.base_url)
        return {"health": health_res, "providers": list_providers()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
