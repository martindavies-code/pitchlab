"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { AssumptionsConfig, DatabaseCapabilities } from "@/lib/types";

interface AssumptionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  assumptions: AssumptionsConfig;
  capabilities: DatabaseCapabilities | null;
  onApply: (updated: Partial<AssumptionsConfig>) => Promise<void>;
  isBusy: boolean;
}

export function AssumptionsDrawer({
  isOpen,
  onClose,
  assumptions,
  capabilities,
  onApply,
  isBusy,
}: AssumptionsDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<AssumptionsConfig>(assumptions);

  useEffect(() => {
    setDraft(assumptions);
  }, [assumptions]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = "";
      onClose();
    };
    dialog.addEventListener("close", handleClose);

    // Fallback light-dismiss where <dialog closedby="any"> is unsupported
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!("closedBy" in HTMLDialogElement.prototype)) {
        pressedOutside = isOutside(e);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!("closedBy" in HTMLDialogElement.prototype) && pressedOutside && isOutside(e)) {
        dialog.close("dismiss");
      }
    };
    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);

    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [onClose]);

  const teams = capabilities?.teams || [];
  const players = capabilities?.players || [];
  const seasons = capabilities?.seasons || ["2023/2024", "2024/2025"];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onApply(draft);
    dialogRef.current?.close("apply");
  };

  return (
    <dialog
      ref={dialogRef}
      className="studio-dialog"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as any)}
    >
      <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id={titleId} style={{ margin: 0, fontSize: "1.05rem" }}>
            Assumptions & Tactical Logic Overrides
          </h2>
          <p style={{ margin: "0.2rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Correct any definition, minute threshold, normalization, or pitch grid and rerun verification immediately.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => dialogRef.current?.close("cancel")}>
          Close
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ padding: "1rem 1.25rem", overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.85rem" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Primary Club</span>
          <select
            autoFocus
            className="field-select"
            value={draft.team_name}
            onChange={(e) => setDraft({ ...draft, team_name: e.target.value })}
          >
            {teams.map((t) => (
              <option key={t.team_id} value={t.team_name}>
                {t.team_name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Opponent / Target Club</span>
          <select
            className="field-select"
            value={draft.opponent_name}
            onChange={(e) => setDraft({ ...draft, opponent_name: e.target.value, target_club: e.target.value })}
          >
            {teams.map((t) => (
              <option key={t.team_id} value={t.team_name}>
                {t.team_name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Target Player (Fit Matcher)</span>
          <select
            className="field-select"
            value={draft.player_name}
            onChange={(e) => setDraft({ ...draft, player_name: e.target.value })}
          >
            {players.map((p) => (
              <option key={p.player_id} value={p.player_name}>
                {p.player_name} ({p.team_name})
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Active Season</span>
          <select
            className="field-select"
            value={draft.season_name}
            onChange={(e) => setDraft({ ...draft, season_name: e.target.value })}
          >
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Normalization Method</span>
          <select
            className="field-select"
            value={draft.normalisation}
            onChange={(e) => setDraft({ ...draft, normalisation: e.target.value as any })}
          >
            <option value="per_90">Per 90 Minutes</option>
            <option value="possession_adjusted">Possession-Adjusted (PAdj)</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Coordinate Pitch Grid</span>
          <select
            className="field-select"
            value={draft.coord_grid}
            onChange={(e) => setDraft({ ...draft, coord_grid: e.target.value as any })}
          >
            <option value="120x80">120×80 (StatsBomb)</option>
            <option value="105x68">105×68 (FIFA / Metric)</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Minimum Minutes Threshold</span>
          <input
            type="number"
            min={90}
            max={1620}
            step={45}
            className="field-input"
            value={draft.min_minutes}
            onChange={(e) => setDraft({ ...draft, min_minutes: Number(e.target.value) })}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Skill Composite (Progression)</span>
          <select
            className="field-select"
            value={draft.skill_composite}
            onChange={(e) => setDraft({ ...draft, skill_composite: e.target.value as any })}
          >
            <option value="ball_progression">Ball Progression</option>
            <option value="box_threat">Box Threat</option>
            <option value="defensive_disruption">Defensive Disruption</option>
            <option value="chance_creation">Chance Creation</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Rolling Window (Matches)</span>
          <input
            type="number"
            min={2}
            max={10}
            className="field-input"
            value={draft.rolling_window}
            onChange={(e) => setDraft({ ...draft, rolling_window: Number(e.target.value) })}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Intervention Run (Start → End MW)</span>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input
              type="number"
              min={1}
              max={18}
              className="field-input"
              value={draft.start_mw}
              onChange={(e) => setDraft({ ...draft, start_mw: Number(e.target.value) })}
            />
            <input
              type="number"
              min={1}
              max={18}
              className="field-input"
              value={draft.end_mw}
              onChange={(e) => setDraft({ ...draft, end_mw: Number(e.target.value) })}
            />
          </div>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>PPDA Pressing Line (x_105 ≥ m)</span>
          <input
            type="number"
            min={20}
            max={80}
            className="field-input"
            value={draft.ppda_def_line_x}
            onChange={(e) => setDraft({ ...draft, ppda_def_line_x: Number(e.target.value) })}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
          <span>Progressive Pass Min Gain (m)</span>
          <input
            type="number"
            min={5}
            max={25}
            className="field-input"
            value={draft.prog_pass_min_dist}
            onChange={(e) => setDraft({ ...draft, prog_pass_min_dist: Number(e.target.value) })}
          />
        </label>

        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid var(--border-subtle)" }}>
          <button type="button" className="btn" onClick={() => dialogRef.current?.close("cancel")}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={isBusy}>
            {isBusy ? "Re-running Verification..." : "Apply Logic & Re-run Analysis"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
