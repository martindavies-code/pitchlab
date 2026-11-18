"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AgentChatPane } from "@/components/AgentChatPane";
import { AssumptionsDrawer } from "@/components/AssumptionsDrawer";
import { DataAdaptersModal } from "@/components/DataAdaptersModal";
import { VisualCanvasPane } from "@/components/VisualCanvasPane";
import { pitchlabApi } from "@/lib/api";
import type {
  AssumptionsConfig,
  CoordGrid,
  DatabaseCapabilities,
  ModuleId,
  ModuleResultPayload,
  VerificationReport,
  WorkflowSession,
} from "@/lib/types";

const INITIAL_ASSUMPTIONS: AssumptionsConfig = {
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

export default function PitchLabStudioPage() {
  const [capabilities, setCapabilities] = useState<DatabaseCapabilities | null>(null);
  const [activeModule, setActiveModule] = useState<ModuleId>("managerial_impact_tracker");
  const [coordGrid, setCoordGrid] = useState<CoordGrid>("120x80");
  const [assumptions, setAssumptions] = useState<AssumptionsConfig>(INITIAL_ASSUMPTIONS);
  const [result, setResult] = useState<ModuleResultPayload | null>(null);
  const [verification, setVerification] = useState<VerificationReport | null>(null);
  const [session, setSession] = useState<WorkflowSession | null>(null);
  const [isWorkflowView, setIsWorkflowView] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [adaptersOpen, setAdaptersOpen] = useState(false);

  const activeWorkflowSession =
    isWorkflowView && session && session.stage === 5 && session.module_id === activeModule
      ? session
      : null;

  const loadModule = useCallback(
    async (modId: ModuleId, overrides: Partial<AssumptionsConfig> = {}) => {
      setIsBusy(true);
      setErrorBanner(null);
      setIsWorkflowView(false);
      try {
        const merged = { ...assumptions, ...overrides, coord_grid: overrides.coord_grid ?? coordGrid };
        const res = await pitchlabApi.runModule(modId, merged);
        setActiveModule(modId);
        setResult(res.result);
        setVerification(res.verification);
        setAssumptions(res.result.assumptions);
      } catch (err: any) {
        setErrorBanner(err.message);
      } finally {
        setIsBusy(false);
      }
    },
    [assumptions, coordGrid]
  );

  useEffect(() => {
    pitchlabApi
      .getCapabilities()
      .then((caps) => {
        setCapabilities(caps);
        return pitchlabApi.runModule("managerial_impact_tracker", INITIAL_ASSUMPTIONS);
      })
      .then((res) => {
        setIsWorkflowView(false);
        setResult(res.result);
        setVerification(res.verification);
        setAssumptions(res.result.assumptions);
      })
      .catch((err) => setErrorBanner(`Backend connection error: ${err.message}`));
  }, []);

  const handleToggleGrid = async (grid: CoordGrid) => {
    setCoordGrid(grid);
    if (activeWorkflowSession) {
      setIsBusy(true);
      try {
        const updated = await pitchlabApi.overrideAssumptions(activeWorkflowSession.session_id, { coord_grid: grid });
        setSession(updated);
        if (updated.result) {
          setResult(updated.result);
          setVerification(updated.verification);
          setAssumptions(updated.result.assumptions);
        }
      } finally {
        setIsBusy(false);
      }
    } else {
      await loadModule(activeModule, { coord_grid: grid });
    }
  };

  const handleStartPrompt = async (prompt: string) => {
    setIsBusy(true);
    setErrorBanner(null);
    setIsWorkflowView(false);
    try {
      const s1 = await pitchlabApi.startWorkflow(prompt);
      setSession(s1);
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleConfirmStage1 = async (clarifications: Partial<AssumptionsConfig>) => {
    if (!session) return;
    setIsBusy(true);
    setErrorBanner(null);
    try {
      const s2 = await pitchlabApi.confirmStage1(session.session_id, clarifications);
      setSession(s2);
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApproveStage2 = async () => {
    if (!session) return;
    setIsBusy(true);
    setErrorBanner(null);
    try {
      const s3 = await pitchlabApi.approveStage2(session.session_id);
      setSession(s3);
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApproveStage3 = async (paramEdits: Partial<AssumptionsConfig>) => {
    if (!session) return;
    setIsBusy(true);
    setErrorBanner(null);
    try {
      const s4 = await pitchlabApi.approveStage3(session.session_id, { ...paramEdits, coord_grid: coordGrid });
      setSession(s4);
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApproveStage4 = async () => {
    if (!session) return;
    setIsBusy(true);
    setErrorBanner(null);
    try {
      const s5 = await pitchlabApi.approveStage4(session.session_id);
      setSession(s5);
      setActiveModule(s5.module_id);
      setIsWorkflowView(true);
      if (s5.result) {
        setResult(s5.result);
        setVerification(s5.verification);
        setAssumptions(s5.result.assumptions);
      }
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleApplyAssumptions = async (updated: Partial<AssumptionsConfig>) => {
    setIsBusy(true);
    setErrorBanner(null);
    try {
      if (updated.coord_grid) setCoordGrid(updated.coord_grid);
      if (activeWorkflowSession) {
        const rerun = await pitchlabApi.overrideAssumptions(activeWorkflowSession.session_id, updated);
        setSession(rerun);
        if (rerun.result) {
          setResult(rerun.result);
          setVerification(rerun.verification);
          setAssumptions(rerun.result.assumptions);
        }
      } else {
        await loadModule(activeModule, updated);
      }
    } catch (err: any) {
      setErrorBanner(err.message);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="studio-shell">
      {/* Top Studio Header Bar */}
      <header className="studio-header no-print">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #0ea5e9, #10b981)", display: "grid", placeItems: "center", fontWeight: 900, color: "#06121e" }}>
            PL
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.05rem", letterSpacing: "-0.01em" }}>PitchLab Studio</h1>
            <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
              Local-First Football Analytics · DuckDB + FastAPI + Dual-Grid SVG
            </div>
          </div>
          {capabilities && (
            <span className="badge badge-ok">
              DuckDB: {capabilities.table_counts.matches} matches · {capabilities.table_counts.events.toLocaleString()} events · {capabilities.table_counts.players} players
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", background: "var(--bg-elevated)", borderRadius: 8, padding: "0.18rem", border: "1px solid var(--border-subtle)" }}>
            <button
              type="button"
              className={`btn ${coordGrid === "120x80" ? "btn-primary" : ""}`}
              style={{ border: "none", padding: "0.3rem 0.6rem", fontSize: "0.76rem" }}
              onClick={() => handleToggleGrid("120x80")}
            >
              120×80 Grid
            </button>
            <button
              type="button"
              className={`btn ${coordGrid === "105x68" ? "btn-primary" : ""}`}
              style={{ border: "none", padding: "0.3rem 0.6rem", fontSize: "0.76rem" }}
              onClick={() => handleToggleGrid("105x68")}
            >
              105×68 Grid
            </button>
          </div>

          <button type="button" className="btn" onClick={() => setAdaptersOpen(true)}>
            Data Adapters & Ingest
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setAssumptionsOpen(true)}>
            Assumptions & Logic
          </button>
        </div>
      </header>

      {errorBanner && (
        <div className="no-print" style={{ margin: "0.75rem 1.25rem 0", padding: "0.6rem 0.85rem", borderRadius: 8, background: "rgba(244, 63, 94, 0.16)", border: "1px solid #f43f5e", color: "#fda4af", fontSize: "0.82rem" }}>
          {errorBanner}
        </div>
      )}

      {/* Split-Pane Studio Workspace */}
      <main className="studio-split">
        <AgentChatPane
          session={session}
          capabilities={capabilities}
          isBusy={isBusy}
          onStartPrompt={handleStartPrompt}
          onConfirmStage1={handleConfirmStage1}
          onApproveStage2={handleApproveStage2}
          onApproveStage3={handleApproveStage3}
          onApproveStage4={handleApproveStage4}
          onOpenAssumptions={() => setAssumptionsOpen(true)}
        />

        <VisualCanvasPane
          activeModule={activeModule}
          onSelectModule={(modId) => loadModule(modId)}
          result={result}
          verification={verification}
          coordGrid={coordGrid}
          isBusy={isBusy}
          questionPrompt={activeWorkflowSession ? activeWorkflowSession.prompt : undefined}
          onOpenAssumptions={() => setAssumptionsOpen(true)}
        />
      </main>

      <AssumptionsDrawer
        isOpen={assumptionsOpen}
        onClose={() => setAssumptionsOpen(false)}
        assumptions={assumptions}
        capabilities={capabilities}
        onApply={handleApplyAssumptions}
        isBusy={isBusy}
      />

      <DataAdaptersModal
        isOpen={adaptersOpen}
        onClose={() => setAdaptersOpen(false)}
        onDataUpdated={(caps) => {
          setCapabilities(caps);
          loadModule(activeModule);
        }}
      />
    </div>
  );
}
