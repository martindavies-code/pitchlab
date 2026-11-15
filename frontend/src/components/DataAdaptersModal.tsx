"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { pitchlabApi } from "@/lib/api";
import type { DatabaseCapabilities, ProviderDescriptor } from "@/lib/types";

interface DataAdaptersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDataUpdated: (caps: DatabaseCapabilities) => void;
}

const CANONICAL_FIELDS = [
  "event_id",
  "match_id",
  "minute",
  "team_name",
  "player_name",
  "event_type",
  "outcome",
  "x",
  "y",
  "end_x",
  "end_y",
  "xg",
];

export function DataAdaptersModal({ isOpen, onClose, onDataUpdated }: DataAdaptersModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  const [tab, setTab] = useState<"statsbomb" | "upload" | "providers">("statsbomb");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewCols, setPreviewCols] = useState<string[]>([]);
  const [presets, setPresets] = useState<Record<string, { coord_system: string; columns: Record<string, string> }>>({});
  const [activePreset, setActivePreset] = useState<string>("opta");
  const [coordSystem, setCoordSystem] = useState<string>("100x100");
  const [mapping, setMapping] = useState<Record<string, string>>({});

  // Providers state
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState<Record<string, string>>({});

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      pitchlabApi.listProviders().then((res) => setProviders(res.providers)).catch(() => {});
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
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const handleLoadStatsBomb = async (mode: "canonical" | "github") => {
    setBusy(true);
    setStatusMsg("");
    try {
      const res = await pitchlabApi.ingestStatsbomb({ mode, reset: mode === "canonical", max_matches: 3 });
      onDataUpdated(res.capabilities);
      setStatusMsg(
        `Loaded ${res.ingest.matches_loaded} matches and ${res.ingest.events_loaded} events from ${res.ingest.source}.`
      );
    } catch (err: any) {
      setStatusMsg(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = async (file: File | null) => {
    if (!file) return;
    setSelectedFile(file);
    setBusy(true);
    setStatusMsg("");
    try {
      const prev = await pitchlabApi.uploadPreview(file);
      setPreviewCols(prev.columns);
      setPresets(prev.presets);
      setActivePreset(prev.suggested_preset);
      const presetCfg = prev.presets[prev.suggested_preset];
      if (presetCfg) {
        setCoordSystem(presetCfg.coord_system);
        setMapping(presetCfg.columns);
      }
      setStatusMsg(`Inspected ${prev.filename}: ${prev.row_count} rows, ${prev.columns.length} columns.`);
    } catch (err: any) {
      setStatusMsg(`Preview failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePresetSwitch = (presetName: string) => {
    setActivePreset(presetName);
    const p = presets[presetName];
    if (p) {
      setCoordSystem(p.coord_system);
      setMapping(p.columns);
    }
  };

  const handleUploadIngest = async () => {
    if (!selectedFile) return;
    setBusy(true);
    try {
      const res = await pitchlabApi.uploadIngest({
        file: selectedFile,
        mapping,
        coordSystem,
        dataSource: `${activePreset}_upload`,
        seasonName: "2024/2025",
        competitionName: "Imported Feed",
      });
      onDataUpdated(res.capabilities);
      setStatusMsg(`Ingested ${res.ingest.events_ingested} mapped events into DuckDB.`);
    } catch (err: any) {
      setStatusMsg(`Ingest failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveKey = async (providerId: string) => {
    setBusy(true);
    try {
      const res = await pitchlabApi.configureProvider(providerId, apiKeyInput[providerId] || "");
      setProviders(res.providers);
      setStatusMsg(`${providerId}: ${res.health.status} — ${res.health.message || "Verified"}`);
    } catch (err: any) {
      setStatusMsg(`Provider error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="studio-dialog" aria-labelledby={titleId} {...({ closedby: "any" } as any)}>
      <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 id={titleId} style={{ margin: 0, fontSize: "1.05rem" }}>
            Data Layer & Plug-and-Play Adapters
          </h2>
          <p style={{ margin: "0.2rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Canonical DuckDB Ingestion: StatsBomb Open Data, Wyscout/Opta/FBref/Understat CSV & Parquet, or Live REST APIs.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", padding: "0.75rem 1.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
        <button type="button" autoFocus className={`btn ${tab === "statsbomb" ? "btn-primary" : ""}`} onClick={() => setTab("statsbomb")}>
          1. StatsBomb Open Data
        </button>
        <button type="button" className={`btn ${tab === "upload" ? "btn-primary" : ""}`} onClick={() => setTab("upload")}>
          2. CSV / Parquet Wizard
        </button>
        <button type="button" className={`btn ${tab === "providers" ? "btn-primary" : ""}`} onClick={() => setTab("providers")}>
          3. Commercial REST APIs
        </button>
      </div>

      <div style={{ padding: "1rem 1.25rem", overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        {statusMsg && (
          <div className="badge badge-ok" style={{ borderRadius: 8, padding: "0.5rem 0.75rem", whiteSpace: "normal" }}>
            {statusMsg}
          </div>
        )}

        {tab === "statsbomb" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div className="sub-card">
              <strong style={{ fontSize: "0.9rem" }}>One-Click StatsBomb Canonical Multi-Season Dataset</strong>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.35rem 0 0.75rem" }}>
                Resets and populates the 5 DuckDB tables (matches, teams, players, lineups, events) with 180 two-season fixtures,
                managerial milestone shifts, calibrated shot xG, and exact score/minute parity.
              </p>
              <button type="button" className="btn btn-emerald" disabled={busy} onClick={() => handleLoadStatsBomb("canonical")}>
                {busy ? "Ingesting into DuckDB..." : "Sync Canonical StatsBomb Dataset (180 Matches)"}
              </button>
            </div>

            <div className="sub-card">
              <strong style={{ fontSize: "0.9rem" }}>Live GitHub StatsBomb Open Data Fetcher</strong>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.35rem 0 0.75rem" }}>
                Pulls real JSON match, lineup, and event files directly from github.com/statsbomb/open-data (Competition 2, Season 27 sample).
              </p>
              <button type="button" className="btn" disabled={busy} onClick={() => handleLoadStatsBomb("github")}>
                {busy ? "Fetching GitHub JSONs..." : "Append Live GitHub StatsBomb Sample"}
              </button>
            </div>
          </div>
        )}

        {tab === "upload" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div
              className="sub-card"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFileChange(e.dataTransfer.files?.[0] || null);
              }}
              style={{ borderStyle: "dashed", textAlign: "center", padding: "1.1rem" }}
            >
              <p style={{ margin: "0 0 0.5rem", fontSize: "0.84rem" }}>
                Drag & drop a <strong>.csv</strong> or <strong>.parquet</strong> export (Wyscout, Opta, FBref, Understat)
              </p>
              <input
                type="file"
                accept=".csv,.parquet,.pq"
                onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
              />
            </div>

            {previewCols.length > 0 && (
              <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                  <label style={{ flex: 1, fontSize: "0.78rem" }}>
                    Vendor Preset
                    <select className="field-select" value={activePreset} onChange={(e) => handlePresetSwitch(e.target.value)}>
                      <option value="wyscout">Wyscout (100×100)</option>
                      <option value="opta">Opta (100×100)</option>
                      <option value="fbref">FBref (120×80)</option>
                      <option value="understat">Understat (1×1)</option>
                    </select>
                  </label>
                  <label style={{ flex: 1, fontSize: "0.78rem" }}>
                    Source Coordinate Grid
                    <select className="field-select" value={coordSystem} onChange={(e) => setCoordSystem(e.target.value)}>
                      <option value="100x100">100×100 (Opta / Wyscout)</option>
                      <option value="120x80">120×80 (StatsBomb)</option>
                      <option value="105x68">105×68 (FIFA Metric)</option>
                      <option value="1x1">1×1 (Understat)</option>
                    </select>
                  </label>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.5rem" }}>
                  {CANONICAL_FIELDS.map((field) => (
                    <label key={field} style={{ fontSize: "0.74rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      <span>{field}</span>
                      <select
                        className="field-select"
                        value={mapping[field] || ""}
                        onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                      >
                        <option value="">-- unmapped --</option>
                        {previewCols.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>

                <button type="button" className="btn btn-emerald" disabled={busy} onClick={handleUploadIngest}>
                  {busy ? "Normalizing & Writing to DuckDB..." : "Ingest Mapped File into Canonical Schema"}
                </button>
              </div>
            )}
          </div>
        )}

        {tab === "providers" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
            {providers.map((p) => (
              <div key={p.provider_id} className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: "0.86rem" }}>{p.display_name}</strong>
                  <span className={`badge ${p.is_configured ? "badge-ok" : ""}`}>
                    {p.is_configured ? `Configured ${p.api_key_masked}` : `${p.coord_system} · Not Configured`}
                  </span>
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Endpoint: <code>{p.base_url}</code> · Capabilities: {p.capabilities.join(", ")}
                </div>
                {p.provider_id !== "statsbomb_open" && (
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <input
                      type="password"
                      className="field-input"
                      placeholder={`Enter ${p.display_name} API Key`}
                      value={apiKeyInput[p.provider_id] || ""}
                      onChange={(e) => setApiKeyInput({ ...apiKeyInput, [p.provider_id]: e.target.value })}
                    />
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => handleSaveKey(p.provider_id)}>
                      Save Key
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}
