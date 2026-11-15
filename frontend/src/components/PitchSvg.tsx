"use client";

import React, { useState } from "react";
import type { CoordGrid, PitchPayload } from "@/lib/types";

interface PitchSvgProps {
  pitch: PitchPayload;
  coordGrid: CoordGrid;
  svgRef?: React.RefObject<SVGSVGElement | null>;
}

export function PitchSvg({ pitch, coordGrid, svgRef }: PitchSvgProps) {
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);

  const W = coordGrid === "105x68" ? 105 : 120;
  const H = coordGrid === "105x68" ? 68 : 80;
  const pad = coordGrid === "105x68" ? 4 : 4.5;

  // Standard UEFA / StatsBomb dimensions scaled cleanly to active grid
  const boxLen = coordGrid === "105x68" ? 16.5 : 18.0;
  const boxHalfW = coordGrid === "105x68" ? 20.16 : 22.0;
  const sixLen = coordGrid === "105x68" ? 5.5 : 6.0;
  const sixHalfW = coordGrid === "105x68" ? 9.16 : 10.0;
  const penSpot = coordGrid === "105x68" ? 11.0 : 12.0;
  const centerR = coordGrid === "105x68" ? 9.15 : 10.0;
  const goalHalfW = coordGrid === "105x68" ? 3.66 : 4.0;
  const midY = H / 2;
  const midX = W / 2;

  return (
    <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.84rem", fontWeight: 600 }}>{pitch.title}</span>
        <span className="badge">{coordGrid} Grid (Attacking Left → Right)</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`}
        style={{
          width: "100%",
          height: "auto",
          maxHeight: "360px",
          borderRadius: "10px",
          background: "#0d2318",
          border: "1px solid #1e3f2d",
        }}
        role="img"
        aria-label={pitch.title}
      >
        <defs>
          <marker id="pitch-arrow-head" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
            <path d="M0,0 L4,2 L0,4 Z" fill="#38bdf8" />
          </marker>
          <marker id="pitch-arrow-purple" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
            <path d="M0,0 L4,2 L0,4 Z" fill="#a855f7" />
          </marker>
          <marker id="pitch-arrow-cyan" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
            <path d="M0,0 L4,2 L0,4 Z" fill="#22d3ee" />
          </marker>
        </defs>

        {/* Turf stripes */}
        {Array.from({ length: 10 }).map((_, idx) => (
          <rect
            key={idx}
            x={(idx * W) / 10}
            y={0}
            width={W / 10}
            height={H}
            fill={idx % 2 === 0 ? "#0f2a1d" : "#123223"}
          />
        ))}

        {/* Tactical / Shot Heatmap Zones */}
        {pitch.zones.map((z) => {
          const alpha = Math.min(0.72, 0.14 + z.intensity * 0.62);
          return (
            <g
              key={z.zone_id}
              onMouseEnter={() => setHoveredLabel(z.tooltip)}
              onMouseLeave={() => setHoveredLabel(null)}
              style={{ cursor: "pointer" }}
            >
              <rect
                x={z.x}
                y={z.y}
                width={z.width}
                height={z.height}
                fill={`rgba(56, 189, 248, ${alpha.toFixed(2)})`}
                stroke="rgba(186, 230, 253, 0.45)"
                strokeWidth={0.25}
              />
              <text
                x={z.x + z.width / 2}
                y={z.y + z.height / 2 + 0.8}
                textAnchor="middle"
                fill="#f8fafc"
                fontSize={coordGrid === "105x68" ? 2.2 : 2.5}
                fontWeight="700"
              >
                {z.value_label}
              </text>
            </g>
          );
        })}

        {/* Pitch Outer & Halfway Lines */}
        <g stroke="rgba(226, 245, 235, 0.78)" strokeWidth={0.35} fill="none">
          <rect x={0} y={0} width={W} height={H} />
          <line x1={midX} y1={0} x2={midX} y2={H} />
          <circle cx={midX} cy={midY} r={centerR} />
          <circle cx={midX} cy={midY} r={0.5} fill="rgba(226, 245, 235, 0.85)" />

          {/* Left Penalty Area & Six-Yard Box */}
          <rect x={0} y={midY - boxHalfW} width={boxLen} height={boxHalfW * 2} />
          <rect x={0} y={midY - sixHalfW} width={sixLen} height={sixHalfW * 2} />
          <circle cx={penSpot} cy={midY} r={0.45} fill="rgba(226, 245, 235, 0.85)" />
          <rect x={-1.4} y={midY - goalHalfW} width={1.4} height={goalHalfW * 2} />

          {/* Right Penalty Area & Six-Yard Box */}
          <rect x={W - boxLen} y={midY - boxHalfW} width={boxLen} height={boxHalfW * 2} />
          <rect x={W - sixLen} y={midY - sixHalfW} width={sixLen} height={sixHalfW * 2} />
          <circle cx={W - penSpot} cy={midY} r={0.45} fill="rgba(226, 245, 235, 0.85)" />
          <rect x={W} y={midY - goalHalfW} width={1.4} height={goalHalfW * 2} />
        </g>

        {/* Pass / Carry Arrows */}
        {pitch.arrows.map((a, idx) => {
          const markerRef =
            a.color === "#a855f7"
              ? "url(#pitch-arrow-purple)"
              : a.color === "#22d3ee"
                ? "url(#pitch-arrow-cyan)"
                : "url(#pitch-arrow-head)";
          return (
            <line
              key={idx}
              x1={a.x1}
              y1={a.y1}
              x2={a.x2}
              y2={a.y2}
              stroke={a.color}
              strokeWidth={0.55}
              strokeOpacity={0.85}
              markerEnd={markerRef}
              onMouseEnter={() => setHoveredLabel(a.label)}
              onMouseLeave={() => setHoveredLabel(null)}
              style={{ cursor: "pointer" }}
            />
          );
        })}

        {/* Shot / Action Markers */}
        {pitch.markers.map((m, idx) => (
          <circle
            key={idx}
            cx={m.x}
            cy={m.y}
            r={Math.max(0.95, m.radius * (coordGrid === "105x68" ? 0.28 : 0.31))}
            fill={m.color}
            fillOpacity={0.82}
            stroke="#061019"
            strokeWidth={0.28}
            onMouseEnter={() => setHoveredLabel(m.label)}
            onMouseLeave={() => setHoveredLabel(null)}
            style={{ cursor: "pointer" }}
          >
            <title>{m.label}</title>
          </circle>
        ))}

        {/* Coordinate axis indicator */}
        <text x={1} y={H + 3.1} fill="#86efac" fontSize={2.3} opacity={0.85}>
          (0,0)
        </text>
        <text x={W - 14} y={H + 3.1} fill="#86efac" fontSize={2.3} opacity={0.85}>
          ({W},{H})
        </text>
      </svg>

      <div style={{ minHeight: "1.25rem", fontSize: "0.78rem", color: "#93c5fd" }}>
        {hoveredLabel ? hoveredLabel : "Hover over any shot marker, arrow, or pitch zone to inspect exact coordinates & telemetry."}
      </div>
    </div>
  );
}
