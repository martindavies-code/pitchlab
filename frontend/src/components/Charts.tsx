"use client";

import React, { useState } from "react";
import type { ModuleResultPayload } from "@/lib/types";

interface ModuleChartsProps {
  result: ModuleResultPayload;
}

export function ModuleCharts({ result }: ModuleChartsProps) {
  const [tooltip, setTooltip] = useState<string | null>(null);
  const { module_id, charts } = result;

  if (module_id === "managerial_impact_tracker") {
    const timeline: Array<Record<string, any>> = charts.timeline || [];
    const milestones: Array<Record<string, any>> = charts.milestones || [];
    if (!timeline.length) {
      return (
        <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
          <strong>No Managerial Split Telemetry Available</strong> — 0 matches found for{" "}
          {result.assumptions.team_name} in {result.assumptions.season_name}. No rolling xGD/PPG chart or comparison metrics were generated.
        </div>
      );
    }

    const W = 680;
    const H = 240;
    const padL = 44;
    const padR = 20;
    const padT = 24;
    const padB = 34;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(3.2, ...timeline.map((t) => Math.max(t.rolling_ppg || 0, t.rolling_xgf || 0, t.rolling_xga || 0))) * 1.05;

    const xPos = (idx: number) =>
      padL + (timeline.length <= 1 ? plotW / 2 : (idx / (timeline.length - 1)) * plotW);
    const yPos = (val: number) => padT + plotH - (val / maxVal) * plotH;

    const poly = (key: string) =>
      timeline.map((t, i) => `${xPos(i).toFixed(1)},${yPos(Number(t[key] || 0)).toFixed(1)}`).join(" ");

    return (
      <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <strong style={{ fontSize: "0.86rem" }}>
            Rolling {charts.rolling_window}-Match PPG vs xG Created & Conceded
          </strong>
          <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.75rem" }}>
            <span style={{ color: "#38bdf8" }}>● Rolling PPG</span>
            <span style={{ color: "#10b981" }}>● Rolling xGF</span>
            <span style={{ color: "#f43f5e" }}>● Rolling xGA</span>
            <span style={{ color: "#fbbf24" }}>┆ Milestone</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", background: "#0b111d", borderRadius: 8 }}>
          {[0, 1, 2, 3].map((tick) => {
            const y = yPos(tick);
            return (
              <g key={tick}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#1f2d45" strokeDasharray="3 3" />
                <text x={padL - 8} y={y + 4} textAnchor="end" fill="#8fa3c4" fontSize="10">
                  {tick.toFixed(1)}
                </text>
              </g>
            );
          })}

          {milestones.map((m, idx) => {
            const mIdx = timeline.findIndex((t) => t.match_week === m.match_week);
            if (mIdx < 0) return null;
            const mx = xPos(mIdx);
            return (
              <g key={idx}>
                <line x1={mx} y1={padT} x2={mx} y2={H - padB} stroke="#fbbf24" strokeWidth="1.8" strokeDasharray="5 4" />
                <text x={mx + 4} y={padT + 10} fill="#fbbf24" fontSize="10" fontWeight="700">
                  {m.label} ({m.match_date})
                </text>
              </g>
            );
          })}

          <polyline fill="none" stroke="#38bdf8" strokeWidth="2.4" points={poly("rolling_ppg")} />
          <polyline fill="none" stroke="#10b981" strokeWidth="2.2" points={poly("rolling_xgf")} />
          <polyline fill="none" stroke="#f43f5e" strokeWidth="2.2" points={poly("rolling_xga")} />

          {timeline.map((t, i) => (
            <g key={t.match_id}>
              <circle
                cx={xPos(i)}
                cy={yPos(t.rolling_ppg)}
                r={4}
                fill="#38bdf8"
                onMouseEnter={() =>
                  setTooltip(
                    `MW ${t.match_week} (${t.match_date}) vs ${t.opponent} (${t.gf}-${t.ga}) — Manager: ${t.manager} | Roll PPG: ${t.rolling_ppg}, Roll xGF: ${t.rolling_xgf}, Roll xGA: ${t.rolling_xga}`
                  )
                }
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: "pointer" }}
              />
              {i % 2 === 0 && (
                <text x={xPos(i)} y={H - 12} textAnchor="middle" fill="#8fa3c4" fontSize="9.5">
                  MW{t.match_week}
                </text>
              )}
            </g>
          ))}
        </svg>
        <div style={{ fontSize: "0.78rem", color: "#93c5fd", minHeight: "1.2rem" }}>
          {tooltip || "Hover over matchweek points to inspect scorelines, active manager, and rolling xG splits."}
        </div>
      </div>
    );
  }

  if (module_id === "tactical_intervention_comparison" || module_id === "tactical_fit_recruitment_matcher") {
    const radar: Array<Record<string, any>> = charts.radar || [];
    const isFit = module_id === "tactical_fit_recruitment_matcher";
    const mw = (charts.match_window || {}) as Record<string, any>;
    const startMw = mw.start_mw ?? result.assumptions.start_mw;
    const endMw = mw.end_mw ?? result.assumptions.end_mw;

    if (!radar.length) {
      if (isFit) {
        const playerNotFound = charts.player_matched === false;
        return (
          <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
            <strong>
              {playerNotFound
                ? `Tactical Fit Unavailable — Requested player "${result.assumptions.player_name}" Not Found`
                : `Tactical Fit Unavailable — Insufficient Club Telemetry (${result.assumptions.season_name})`}
            </strong>
            <div style={{ marginTop: "0.3rem", color: "var(--text-muted)" }}>
              {playerNotFound
                ? `No catalog match exists for "${result.assumptions.player_name}" in ${result.assumptions.season_name}. No substitute player, fit score, radar, or adaptation advice was generated.`
                : `Required club style telemetry was missing for ${result.assumptions.target_club} in ${result.assumptions.season_name}. No fit score or radar comparison was generated.`}
            </div>
          </div>
        );
      }
      return (
        <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
          <strong>No Intervention or Season Baseline Telemetry Available</strong> — 0 matches found for{" "}
          {result.assumptions.team_name} in {result.assumptions.season_name}. No radar or percentile comparison was generated.
        </div>
      );
    }

    const hasInterventionRun = !isFit && radar.some((r) => r.intervention_run !== null && r.intervention_run !== undefined);
    const size = 280;
    const cx = size / 2;
    const cy = size / 2;
    const maxR = 94;
    const n = radar.length;

    const pointAt = (idx: number, pct: number) => {
      const ang = -Math.PI / 2 + (idx * 2 * Math.PI) / n;
      const r = (Math.max(8, Math.min(100, pct)) / 100) * maxR;
      return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
    };

    const polyB = radar
      .map((item, i) => pointAt(i, isFit ? 100 : Number(item.season_percentile ?? 0)).map((v) => v.toFixed(1)).join(","))
      .join(" ");
    const polyA =
      isFit || hasInterventionRun
        ? radar
            .map((item, i) =>
              pointAt(i, Number(isFit ? item.overlap_pct ?? 0 : item.run_percentile ?? 0))
                .map((v) => v.toFixed(1))
                .join(",")
            )
            .join(" ")
        : null;

    return (
      <div className="radar-split-grid">
        <div className="sub-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.45rem" }}>
          <strong style={{ fontSize: "0.84rem", textAlign: "center" }}>
            {isFit
              ? charts.fit_score !== null && charts.fit_score !== undefined
                ? `Tactical Fit Score: ${charts.fit_score}%`
                : "Tactical Fit Unavailable"
              : hasInterventionRun
                ? "Style Percentile Radar"
                : "Season Baseline Profile Only (Intervention Window Unavailable)"}
          </strong>
          <svg viewBox={`0 0 ${size} ${size}`} style={{ width: "100%", maxWidth: 260 }}>
            {[25, 50, 75, 100].map((ring) => (
              <circle key={ring} cx={cx} cy={cy} r={(ring / 100) * maxR} fill="none" stroke="#25344d" strokeDasharray="3 3" />
            ))}
            {radar.map((item, i) => {
              const [lx, ly] = pointAt(i, 118);
              const [ex, ey] = pointAt(i, 100);
              return (
                <g key={i}>
                  <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="#25344d" />
                  <text x={lx} y={ly} textAnchor="middle" fill="#b7c7e2" fontSize="8.5" fontWeight="600">
                    {String(item.metric).split("(")[0].trim().slice(0, 18)}
                  </text>
                </g>
              );
            })}
            <polygon points={polyB} fill="rgba(148, 163, 184, 0.16)" stroke="#94a3b8" strokeWidth="1.6" />
            {polyA && <polygon points={polyA} fill="rgba(56, 189, 248, 0.28)" stroke="#38bdf8" strokeWidth="2.2" />}
          </svg>
          <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.73rem", flexWrap: "wrap", justifyContent: "center" }}>
            {isFit ? (
              <>
                <span style={{ color: "#38bdf8" }}>● Alignment Overlap %</span>
                <span style={{ color: "#94a3b8" }}>● 100% Target Profile</span>
              </>
            ) : hasInterventionRun ? (
              <>
                <span style={{ color: "#38bdf8" }}>● Intervention Run (MW {startMw}–{endMw})</span>
                <span style={{ color: "#94a3b8" }}>● Season Baseline</span>
              </>
            ) : (
              <>
                <span style={{ color: "#94a3b8" }}>● Season Baseline ({mw.season_matches ?? "?"} matches)</span>
                <span style={{ color: "#fbbf24" }}>○ MW {startMw}–{endMw}: 0 matches (unavailable)</span>
              </>
            )}
          </div>
        </div>

        <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
          <strong style={{ fontSize: "0.84rem" }}>
            {isFit
              ? "Stylistic Overlap & Adaptation Risks"
              : hasInterventionRun
                ? "Percentile Comparison Bars (0–100)"
                : `Season Baseline Percentiles (MW ${startMw}–${endMw}: 0 Matches — No Comparison)`}
          </strong>
          {radar.map((item, i) => {
            const basePct = Number(isFit ? 100 : item.season_percentile ?? 0);
            const valPct = isFit ? Number(item.overlap_pct ?? 0) : hasInterventionRun ? Number(item.run_percentile ?? 0) : basePct;
            const barColor = !isFit && !hasInterventionRun
              ? "#64748b"
              : valPct >= 75
                ? "#10b981"
                : valPct >= 50
                  ? "#38bdf8"
                  : "#f59e0b";
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.25rem", fontSize: "0.78rem" }}>
                  <span>{item.metric}</span>
                  <span style={{ color: !isFit && !hasInterventionRun ? "#cbd5e1" : "#93c5fd", fontWeight: 600 }}>
                    {isFit
                      ? `${item.current_club_val} → ${item.target_club_val} (${valPct}% fit)`
                      : hasInterventionRun
                        ? `${item.intervention_run} vs ${item.season_avg} (P${valPct} vs P${basePct})`
                        : `${item.season_avg} (Season P${basePct} · MW ${startMw}–${endMw}: N/A)`}
                  </span>
                </div>
                <div style={{ height: 8, background: "#0b111d", borderRadius: 99, overflow: "hidden", position: "relative" }}>
                  <div
                    style={{
                      width: `${Math.max(4, Math.min(100, valPct))}%`,
                      height: "100%",
                      background: barColor,
                    }}
                  />
                </div>
              </div>
            );
          })}
          {isFit && Array.isArray(charts.adaptation_risks) && charts.adaptation_risks.length > 0 && (
            <div style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "#fbbf24" }}>
              <strong>Adaptation Notes:</strong> {charts.adaptation_risks.join(" ")}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (module_id === "opposition_scouting_one_pager") {
    const kpis = charts.style_kpis || {};
    const threats: Array<Record<string, any>> = charts.danger_players || [];
    const formations: Array<Record<string, any>> = charts.formations || [];
    if (Number(kpis.matches_played ?? 0) <= 0) {
      return (
        <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
          <strong>No Opposition Telemetry Available</strong> — 0 matches found for{" "}
          {result.assumptions.opponent_name} in {result.assumptions.season_name}.
        </div>
      );
    }
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
        <div className="sub-card">
          <div style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>Pressing & Build-up Profile</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginTop: "0.5rem" }}>
            <div><div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>PPDA</div><strong style={{ fontSize: "1.1rem", color: "#38bdf8" }}>{kpis.ppda}</strong></div>
            <div><div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Possession</div><strong style={{ fontSize: "1.1rem" }}>{kpis.possession_share}%</strong></div>
            <div><div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>Directness</div><strong style={{ fontSize: "1.1rem" }}>{kpis.build_up_directness}%</strong></div>
            <div><div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>High Turnovers/90</div><strong style={{ fontSize: "1.1rem", color: "#f43f5e" }}>{kpis.high_turnovers_per90}</strong></div>
          </div>
          <div style={{ marginTop: "0.6rem", fontSize: "0.76rem", color: "#93c5fd" }}>
            Formations: {formations.map((f) => `${f.formation} (${f.matches})`).join(" • ")}
          </div>
        </div>

        <div className="sub-card">
          <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", marginBottom: "0.45rem" }}>Top Danger Players</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {threats.map((p, idx) => (
              <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "0.25rem" }}>
                <span><strong>{p.player_name}</strong> <span style={{ color: "var(--text-muted)" }}>({p.position})</span></span>
                <span style={{ color: "#10b981", fontWeight: 600 }}>{p.total_xg} xG · {p.key_passes} KP</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (module_id === "multi_season_player_progression") {
    const leaders: Array<Record<string, any>> = charts.leaderboard || [];
    if (!leaders.length) {
      return (
        <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
          <strong>No Multi-Season Progression Telemetry Available</strong> — 0 qualifying players met the minimum-minutes filter across{" "}
          {result.assumptions.season_1} → {result.assumptions.season_2}.
        </div>
      );
    }
    const maxDelta = Math.max(0.5, ...leaders.map((l) => Math.abs(Number(l.delta || 0))));
    return (
      <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
        <strong style={{ fontSize: "0.85rem" }}>
          Top Composite Improvers ({String(charts.composite || "").replace(/_/g, " ")} — {charts.normalisation})
        </strong>
        {leaders.slice(0, 8).map((p, idx) => {
          const w = Math.max(4, Math.min(100, (Math.abs(p.delta) / maxDelta) * 100));
          return (
            <div key={p.player_id} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 180px) minmax(44px, 1fr) auto", alignItems: "center", gap: "0.5rem", fontSize: "0.78rem" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {idx + 1}. <strong>{p.player_name}</strong> ({p.team_name.split(" ")[0]})
              </span>
              <div style={{ height: 10, background: "#0b111d", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${w}%`, height: "100%", background: p.delta >= 0 ? "#10b981" : "#f43f5e" }} />
              </div>
              <span style={{ textAlign: "right", color: p.delta >= 0 ? "#34d399" : "#fda4af", fontWeight: 700 }}>
                {p.delta >= 0 ? `+${p.delta}` : p.delta} ({p.pct_change >= 0 ? `+${p.pct_change}%` : `${p.pct_change}%`})
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (module_id === "league_table_vs_underlying_play") {
    const scatter: Array<Record<string, any>> = charts.scatter || [];
    if (!scatter.length) {
      return (
        <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
          <strong>No League Table vs xPTS Telemetry Available</strong> — 0 matches found in {result.assumptions.season_name}.
        </div>
      );
    }
    const W = 680;
    const H = 290;
    const padL = 48;
    const padR = 24;
    const padT = 22;
    const padB = 38;
    const maxPts = Math.max(10, ...scatter.map((s) => Math.max(s.actual_pts, s.xpts))) * 1.1;
    const minPts = Math.max(0, Math.min(...scatter.map((s) => Math.min(s.actual_pts, s.xpts))) * 0.85);
    const xPos = (v: number) => padL + ((v - minPts) / Math.max(1, maxPts - minPts)) * (W - padL - padR);
    const yPos = (v: number) => padT + (H - padT - padB) - ((v - minPts) / Math.max(1, maxPts - minPts)) * (H - padT - padB);

    return (
      <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <strong style={{ fontSize: "0.85rem" }}>Actual Points (Y) vs Simulated Expected Points xPTS (X)</strong>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Dashed diagonal = Expected Parity (Actual == xPTS)</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", background: "#0b111d", borderRadius: 8 }}>
          <line x1={xPos(minPts)} y1={yPos(minPts)} x2={xPos(maxPts)} y2={yPos(maxPts)} stroke="#475569" strokeDasharray="5 4" />
          {scatter.map((t) => {
            const cx = xPos(t.xpts);
            const cy = yPos(t.actual_pts);
            const col = t.status === "Overperforming" ? "#10b981" : t.status === "Underperforming" ? "#f43f5e" : "#38bdf8";
            return (
              <g key={t.team_name}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={6}
                  fill={col}
                  stroke="#090e17"
                  strokeWidth="1.5"
                  onMouseEnter={() =>
                    setTooltip(`${t.team_name}: ${t.actual_pts} Pts vs ${t.xpts} xPTS (Residual ${t.pts_residual >= 0 ? "+" : ""}${t.pts_residual})`)
                  }
                  onMouseLeave={() => setTooltip(null)}
                  style={{ cursor: "pointer" }}
                />
                <text x={cx + 8} y={cy + 3} fill="#e2e8f0" fontSize="9.5" fontWeight="600">
                  {t.team_name.replace(" & Hove Albion", "").replace(" Hotspur", "")}
                </text>
              </g>
            );
          })}
          <text x={W / 2} y={H - 8} textAnchor="middle" fill="#8fa3c4" fontSize="10">
            Simulated Expected Points (xPTS)
          </text>
          <text x={14} y={H / 2} textAnchor="middle" fill="#8fa3c4" fontSize="10" transform={`rotate(-90 14 ${H / 2})`}>
            Actual League Points
          </text>
        </svg>
        <div style={{ fontSize: "0.78rem", color: "#93c5fd", minHeight: "1.2rem" }}>
          {tooltip || "Points above the dashed parity line indicate clubs outperforming underlying xG shot quality."}
        </div>
      </div>
    );
  }

  // Shot Location & Zone Efficiency grouped bar summary
  const zones: Array<Record<string, any>> = charts.zone_comparison || [];
  if (!zones.length) {
    return (
      <div className="sub-card" role="status" style={{ fontSize: "0.84rem", color: "#cbd5e1" }}>
        <strong>No Shot Zone Telemetry Available</strong> — 0 open-play or non-empty shots found for{" "}
        {result.assumptions.team_name} in {result.assumptions.season_name}.
      </div>
    );
  }
  return (
    <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
      <strong style={{ fontSize: "0.85rem" }}>Zone Shot Share & xG/Shot vs League Average</strong>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(195px, 1fr))", gap: "0.5rem" }}>
        {zones.slice(0, 6).map((z) => (
          <div key={z.zone} style={{ background: "#0b111d", padding: "0.55rem", borderRadius: 8, border: "1px solid var(--border-subtle)" }}>
            <div style={{ fontSize: "0.76rem", fontWeight: 700, color: "#e2e8f0" }}>{z.zone}</div>
            <div style={{ fontSize: "0.75rem", color: "#93c5fd", marginTop: "0.2rem" }}>
              {z.team_shots} shots ({z.shot_share_pct}% vs {z.league_share_pct}% lg)
            </div>
            <div style={{ fontSize: "0.75rem", color: z.conversion_pct >= z.league_conversion_pct ? "#34d399" : "#fbbf24" }}>
              Conv: {z.conversion_pct}% (Lg {z.league_conversion_pct}%) · xG/sh {z.xg_per_shot}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
