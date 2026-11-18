"use client";

import React, { useRef } from "react";
import { ModuleCharts } from "./Charts";
import { PitchSvg } from "./PitchSvg";
import { ResponsiveTable } from "./ResponsiveTable";
import type { CoordGrid, ModuleId, ModuleResultPayload, VerificationReport } from "@/lib/types";

interface VisualCanvasPaneProps {
  activeModule: ModuleId;
  onSelectModule: (id: ModuleId) => void;
  result: ModuleResultPayload | null;
  verification: VerificationReport | null;
  coordGrid: CoordGrid;
  isBusy: boolean;
  questionPrompt?: string;
  onOpenAssumptions: () => void;
}

const MODULE_TABS: Array<{ id: ModuleId; label: string }> = [
  { id: "managerial_impact_tracker", label: "1. Managerial Impact" },
  { id: "tactical_intervention_comparison", label: "2. Intervention" },
  { id: "opposition_scouting_one_pager", label: "3. Opposition Brief" },
  { id: "multi_season_player_progression", label: "4. Progression" },
  { id: "tactical_fit_recruitment_matcher", label: "5. Tactical Fit" },
  { id: "league_table_vs_underlying_play", label: "6. League vs xPTS" },
  { id: "shot_location_zone_efficiency", label: "7. Shot Zones" },
];

export function VisualCanvasPane({
  activeModule,
  onSelectModule,
  result,
  verification,
  coordGrid,
  isBusy,
  questionPrompt,
  onOpenAssumptions,
}: VisualCanvasPaneProps) {
  const pitchSvgRef = useRef<SVGSVGElement | null>(null);

  const handleExportCsv = () => {
    if (!result || !result.table_rows.length) return;
    const cols = result.table_columns;
    const lines = [
      cols.join(","),
      ...result.table_rows.map((row) =>
        cols
          .map((c) => {
            const val = String(row[c] ?? "");
            return val.includes(",") ? `"${val.replace(/"/g, '""')}"` : val;
          })
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.module_id}_${coordGrid}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    const svg = pitchSvgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svg);
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1440;
      canvas.height = 960;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#090e17";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pngUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = `${result?.module_id || "pitchlab"}_${coordGrid}.png`;
        a.click();
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handleExportPdfPrint = () => {
    window.print();
  };

  return (
    <section className="panel-card" style={{ display: "flex", flexDirection: "column", gap: "0.9rem", minWidth: 0 }}>
      {/* Standalone Template Switcher */}
      <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "0.75rem" }}>
        {MODULE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`btn ${activeModule === tab.id ? "btn-primary" : ""}`}
            style={{ fontSize: "0.78rem", padding: "0.38rem 0.68rem" }}
            disabled={isBusy}
            onClick={() => onSelectModule(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!result ? (
        <div className="sub-card" style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>
          Loading analytical module from DuckDB...
        </div>
      ) : (
        <>
          {/* Result Header & Export Controls */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{result.title}</h2>
                {verification && (
                  <span className={`badge ${verification.all_passed ? "badge-ok" : "badge-warn"}`}>
                    {verification.all_passed
                      ? `Verified ${verification.checks_passed}/${verification.checks_total}`
                      : `Verification Warning ${verification.checks_passed}/${verification.checks_total}`}
                  </span>
                )}
              </div>
              <p style={{ margin: "0.35rem 0 0", fontSize: "0.86rem", color: "#cbd5e1" }}>{result.summary}</p>
            </div>

            <div className="no-print" style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={onOpenAssumptions}>
                Assumptions & Logic
              </button>
              <button type="button" className="btn" onClick={handleExportCsv}>
                Export CSV
              </button>
              <button type="button" className="btn" onClick={handleExportPng}>
                Export PNG
              </button>
              <button type="button" className="btn" onClick={handleExportPdfPrint}>
                Print / PDF
              </button>
            </div>
          </div>

          {/* Conclusion Answering the Question */}
          {(result.conclusion || result.summary) && (
            <div className="conclusion-card" role="region" aria-label="Analytical Conclusion">
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span className={`badge ${verification && !verification.all_passed ? "badge-warn" : "badge-ok"}`}>
                  {verification && !verification.all_passed ? "Conclusion · Verification Warning" : "Conclusion"}
                </span>
                {questionPrompt && (
                  <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                    Answering: &ldquo;{questionPrompt}&rdquo;
                  </span>
                )}
              </div>
              <p>{result.conclusion || result.summary}</p>
            </div>
          )}

          {/* Interactive Analytical Charts */}
          <ModuleCharts result={result} />

          {/* Interactive SVG Pitch (when pitch markers, arrows, or zones exist) */}
          {(result.pitch.markers.length > 0 || result.pitch.arrows.length > 0 || result.pitch.zones.length > 0) && (
            <PitchSvg pitch={result.pitch} coordGrid={result.coord_grid} svgRef={pitchSvgRef} />
          )}

          {/* Responsive Semantic Data Table */}
          <ResponsiveTable
            caption={`${result.title} — Normalized Data Table (${result.assumptions.normalisation}, min ${result.assumptions.min_minutes}m)`}
            columns={result.table_columns}
            rows={result.table_rows}
          />
        </>
      )}
    </section>
  );
}
