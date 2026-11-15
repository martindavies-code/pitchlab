"use client";

import React, { useState } from "react";
import type { AssumptionsConfig, DatabaseCapabilities, WorkflowSession } from "@/lib/types";

interface AgentChatPaneProps {
  session: WorkflowSession | null;
  capabilities: DatabaseCapabilities | null;
  isBusy: boolean;
  onStartPrompt: (prompt: string) => Promise<void>;
  onConfirmStage1: (clarifications: Partial<AssumptionsConfig>) => Promise<void>;
  onApproveStage2: () => Promise<void>;
  onApproveStage3: (paramEdits: Partial<AssumptionsConfig>) => Promise<void>;
  onApproveStage4: () => Promise<void>;
  onOpenAssumptions: () => void;
}

const SAMPLE_PROMPTS = [
  "Is Manchester United going in the right direction since the new manager arrived?",
  "Did anything change for Arsenal after the intervention from matchweek 10 to 18?",
  "What kind of team are we playing on Saturday against Liverpool?",
  "Who improved most last season in ball progression?",
  "Would Cole Palmer fit the way Arsenal play?",
  "Which teams sit higher in the table than their play deserved?",
  "Where are Arsenal shooting from?",
  "Which Arsenal wingers hit the highest top sprint speed km/h and body-pose orientation on freeze-frames?",
];

const STAGES = [
  { num: 1, label: "Clarify" },
  { num: 2, label: "Feasibility" },
  { num: 3, label: "Plan" },
  { num: 4, label: "Verify" },
  { num: 5, label: "Render" },
];

export function AgentChatPane({
  session,
  capabilities,
  isBusy,
  onStartPrompt,
  onConfirmStage1,
  onApproveStage2,
  onApproveStage3,
  onApproveStage4,
  onOpenAssumptions,
}: AgentChatPaneProps) {
  const [promptInput, setPromptInput] = useState(SAMPLE_PROMPTS[0]);
  const [stage1Edits, setStage1Edits] = useState<Partial<AssumptionsConfig>>({});
  const [stage3Edits, setStage3Edits] = useState<Partial<AssumptionsConfig>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim()) return;
    setStage1Edits({});
    setStage3Edits({});
    await onStartPrompt(promptInput.trim());
  };

  const teams = capabilities?.teams || [];
  const currentStage = session?.stage || 0;

  return (
    <aside className="panel-card no-print" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "0.98rem" }}>Gated Analytical Agent</h2>
          <span className="badge">5-Stage Human-in-the-Loop</span>
        </div>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>
          Every query passes intent clarification, schema feasibility, plan approval, and DuckDB verification before rendering.
        </p>
      </div>

      {/* 5-Stage Progress Stepper */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.35rem" }}>
        {STAGES.map((st) => {
          const isHalted = session?.status === "halted_infeasible" && st.num === 2;
          const isDone = currentStage > st.num || (currentStage === 5 && st.num === 5);
          const isActive = currentStage === st.num && !isHalted && !(currentStage === 5 && st.num === 5);
          const bg = isHalted
            ? "rgba(244, 63, 94, 0.22)"
            : isDone
              ? "rgba(16, 185, 129, 0.18)"
              : isActive
                ? "rgba(56, 189, 248, 0.2)"
                : "var(--bg-elevated)";
          const border = isHalted
            ? "#f43f5e"
            : isDone
              ? "#10b981"
              : isActive
                ? "#38bdf8"
                : "var(--border-subtle)";
          return (
            <div
              key={st.num}
              style={{
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: 8,
                padding: "0.35rem 0.25rem",
                textAlign: "center",
                fontSize: "0.72rem",
                fontWeight: 600,
              }}
            >
              <div>{st.num}. {st.label}</div>
            </div>
          );
        })}
      </div>

      {/* Natural-Language Question Form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <textarea
          rows={3}
          className="field-textarea"
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          placeholder="Ask a football tactical question in plain English..."
          aria-label="Ask a football question"
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <button type="submit" className="btn btn-primary" disabled={isBusy} style={{ flex: 1 }}>
            {isBusy ? "Running Stage..." : "Start 5-Stage Analysis"}
          </button>
        </div>
      </form>

      {/* Quick Prompt Chips */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        <span style={{ fontSize: "0.73rem", color: "var(--text-muted)", fontWeight: 600 }}>Quick Questions & Edge Tests</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
          {SAMPLE_PROMPTS.map((q, idx) => (
            <button
              key={idx}
              type="button"
              className={`btn ${idx === SAMPLE_PROMPTS.length - 1 ? "btn-danger" : ""}`}
              style={{ fontSize: "0.71rem", padding: "0.28rem 0.55rem", textAlign: "left" }}
              onClick={() => setPromptInput(q)}
            >
              {idx === SAMPLE_PROMPTS.length - 1 ? "Test Halt: Tracking/360" : `Q${idx + 1}: ${q.slice(0, 32)}…`}
            </button>
          ))}
        </div>
      </div>

      {/* Stage 1 Gate Card */}
      {session && session.stage === 1 && (
        <div className="sub-card" style={{ borderColor: "#38bdf8", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.86rem", color: "#38bdf8" }}>Gate 1: Intent Clarification</strong>
            <span className="badge">{session.module_id.replace(/_/g, " ")}</span>
          </div>
          <p style={{ margin: 0, fontSize: "0.79rem", color: "var(--text-muted)" }}>
            Confirm scoped parameters before inspecting DuckDB coverage:
          </p>
          {session.clarifying_questions.map((cq) => (
            <label key={cq.field} style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.78rem" }}>
              <span>{cq.question}</span>
              <select
                className="field-select"
                value={String((stage1Edits as any)[cq.field] ?? (session.params as any)[cq.field] ?? cq.default)}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsedVal = cq.field === "min_minutes" ? Number(raw) : raw;
                  setStage1Edits({ ...stage1Edits, [cq.field]: parsedVal });
                }}
              >
                {cq.options.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="button"
            className="btn btn-primary"
            disabled={isBusy}
            onClick={() => onConfirmStage1(stage1Edits)}
          >
            Confirm Intent & Check Data Feasibility →
          </button>
        </div>
      )}

      {/* Stage 2 Gate Card (Feasibility or Mandatory Halt) */}
      {session && session.stage >= 2 && session.feasibility && (
        <div
          className="sub-card"
          style={{
            borderColor: session.feasibility.feasible ? "#10b981" : "#f43f5e",
            background: session.feasibility.feasible ? undefined : "rgba(244, 63, 94, 0.08)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: session.feasibility.feasible ? "#34d399" : "#fda4af" }}>
              Gate 2: Data Feasibility Check
            </strong>
            <span className={`badge ${session.feasibility.feasible ? "badge-ok" : "badge-halt"}`}>
              {session.feasibility.feasible ? "FEASIBLE" : "HALTED — MISSING DATA"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem" }}>{session.feasibility.halt_message}</p>

          {!session.feasibility.feasible && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {session.feasibility.missing_requirements.map((mr, i) => (
                <div key={i} style={{ background: "#0b111d", padding: "0.45rem 0.6rem", borderRadius: 6, border: "1px solid rgba(244, 63, 94, 0.4)", fontSize: "0.76rem" }}>
                  <div style={{ fontWeight: 700, color: "#fda4af" }}>Missing: {mr.requirement}</div>
                  <div style={{ color: "var(--text-muted)", marginTop: "0.15rem" }}>{mr.reason}</div>
                </div>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() => setPromptInput("Where are Arsenal shooting from?")}
              >
                Load Feasible Event-Data Question Instead
              </button>
            </div>
          )}

          {session.stage === 2 && session.feasibility.feasible && (
            <button type="button" className="btn btn-primary" disabled={isBusy} onClick={onApproveStage2}>
              Approve Data Coverage & Build Execution Plan →
            </button>
          )}
        </div>
      )}

      {/* Stage 3 Gate Card (Transparent Execution Plan + Inline Edits) */}
      {session && session.stage >= 3 && session.execution_plan && (
        <div className="sub-card" style={{ borderColor: session.stage === 3 ? "#38bdf8" : "var(--border-subtle)", display: "flex", flexDirection: "column", gap: "0.55rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#38bdf8" }}>Gate 3: Transparent Execution Plan</strong>
            <span className="badge">{session.execution_plan.coord_grid}</span>
          </div>
          <p style={{ margin: 0, fontSize: "0.79rem" }}>{session.execution_plan.objective}</p>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            <strong>Normalization:</strong> {session.execution_plan.normalisation_method}
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.75rem", color: "#cbd5e1" }}>
            {session.execution_plan.metrics.map((m, idx) => (
              <li key={idx}>{m}</li>
            ))}
          </ul>
          <div style={{ fontSize: "0.74rem", color: "#fbbf24" }}>
            <strong>Caveats:</strong> {session.execution_plan.statistical_caveats.join(" ")}
          </div>

          {session.stage === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem", paddingTop: "0.4rem", borderTop: "1px solid var(--border-subtle)" }}>
              <span style={{ fontSize: "0.74rem", fontWeight: 600 }}>Inline Parameter Edits (Optional before executing):</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem" }}>
                <select
                  className="field-select"
                  value={String(stage3Edits.team_name ?? session.params.team_name)}
                  onChange={(e) => setStage3Edits({ ...stage3Edits, team_name: e.target.value, opponent_name: e.target.value })}
                >
                  {teams.map((t) => (
                    <option key={t.team_id} value={t.team_name}>
                      {t.team_name}
                    </option>
                  ))}
                </select>
                <select
                  className="field-select"
                  value={String(stage3Edits.normalisation ?? session.params.normalisation)}
                  onChange={(e) => setStage3Edits({ ...stage3Edits, normalisation: e.target.value as any })}
                >
                  <option value="per_90">Per 90</option>
                  <option value="possession_adjusted">Possession-Adjusted (PAdj)</option>
                </select>
              </div>
              <button
                type="button"
                className="btn btn-emerald"
                disabled={isBusy}
                onClick={() => onApproveStage3(stage3Edits)}
              >
                Approve Plan & Run Automated Verification →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stage 4 Gate Card (Automated Verification Report) */}
      {session && session.stage >= 4 && session.verification && (
        <div className="sub-card" style={{ borderColor: session.verification.all_passed ? "#10b981" : "#f59e0b", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#34d399" }}>Gate 4: Automated Verification</strong>
            <span className={`badge ${session.verification.all_passed ? "badge-ok" : "badge-warn"}`}>
              {session.verification.checks_passed}/{session.verification.checks_total} Checks Passed
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {session.verification.checks.map((chk) => (
              <div key={chk.check_id} style={{ fontSize: "0.74rem", background: "#0b111d", padding: "0.4rem 0.55rem", borderRadius: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{chk.label}</strong>
                  <span style={{ color: chk.passed ? "#34d399" : "#fda4af" }}>{chk.passed ? "PASS" : "FAIL"}</span>
                </div>
                <div style={{ color: "var(--text-muted)" }}>{chk.observed}</div>
              </div>
            ))}
          </div>
          {session.stage === 4 && (
            <button type="button" className="btn btn-primary" disabled={isBusy} onClick={onApproveStage4}>
              Approve Verification & Render Visual Canvas →
            </button>
          )}
        </div>
      )}

      {/* Stage 5 Completed Card */}
      {session && session.stage === 5 && session.result && (
        <div className="sub-card" style={{ borderColor: "#10b981", display: "flex", flexDirection: "column", gap: "0.45rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#34d399" }}>Stage 5: Validated Render Active</strong>
            <span className="badge badge-ok">Verified</span>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem" }}>{session.result.summary}</p>
          <button type="button" className="btn" onClick={onOpenAssumptions}>
            Edit Assumptions & Logic Drawer
          </button>
        </div>
      )}
    </aside>
  );
}
