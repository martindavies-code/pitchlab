# PitchLab Studio — Architecture & Canonical Schema

PitchLab Studio is a local-first football analytics platform and gated conversational app builder powered by **Next.js (TypeScript)**, **Python FastAPI**, **DuckDB**, and **dual-coordinate interactive SVG pitch visualizations** (`120×80` StatsBomb & `105×68` FIFA/Metric).

---

## 1. System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                       Next.js Studio Frontend (:3000)                   │
│  ┌────────────────────────────────┬──────────────────────────────────┐  │
│  │ Left Pane: Gated Agentic Flow  │ Right Pane: Visual Canvas & Export│  │
│  │ • Natural-language prompt bar  │ • Dual-grid SVG Pitch (120x80 /  │  │
│  │ • 5-Stage Approval Gate Cards  │   105x68) with zones & markers   │  │
│  │ • Stage 2 Feasibility Halt     │ • 7 Analytical Module Templates  │  │
│  │ • Assumptions & Logic <dialog> │ • Responsive Tables & PNG/CSV/PDF│  │
│  └───────────────┬────────────────┴──────────────────┬───────────────┘  │
└──────────────────┼───────────────────────────────────┼──────────────────┘
                   │ Typed REST API (JSON / Multipart) │
┌──────────────────▼───────────────────────────────────▼──────────────────┐
│                     Python FastAPI Backend (:8000)                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────┐  │
│  │ 5-Stage Gated Agent  │  │ 7 Analytical Modules │  │ Stage 4 Audit │  │
│  │ (backend/agent)      │─▶│ (backend/analytics)  │─▶│ Verification  │  │
│  └──────────────────────┘  └──────────┬───────────┘  └───────┬───────┘  │
│                                       │                      │          │
│  ┌────────────────────────────────────▼──────────────────────▼───────┐  │
│  │               Modular Data Adapter Layer (backend/adapters)       │  │
│  │  • StatsBomb Open Data Loader (GitHub JSON + Built-in Canonical)  │  │
│  │  • CSV / Parquet Importer (Wyscout, Opta, FBref, Understat)       │  │
│  │  • REST Provider Interface (StatsBomb IQ / Wyscout v3 / Opta API) │  │
│  └────────────────────────────────────┬──────────────────────────────┘  │
│                                       │                                 │
│  ┌────────────────────────────────────▼──────────────────────────────┐  │
│  │             DuckDB Local Analytical Store (data/pitchlab.duckdb)  │  │
│  │      Tables: matches | teams | players | lineups | events         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Canonical DuckDB Schema (5 Core Tables)

All external feeds (StatsBomb Open Data, Wyscout, Opta, FBref, Understat, and REST providers) normalize into five strongly typed DuckDB tables:

1. **`matches`**: Fixture-level metadata, official scores, managers, tactical formations, competition, season, and source coordinate grid.
2. **`teams`**: Club directory with primary formation, manager, country, and competition tier.
3. **`players`**: Player registry with canonical ID, club affiliation, primary position, and position group (`GK`, `DF`, `MF`, `FW`).
4. **`lineups`**: Match-level appearances with starter flag, `minute_on`, `minute_off`, exact `minutes_played`, jersey number, and tactical formation.
5. **`events`**: Event stream storing both native `120×80` StatsBomb coordinates (`x, y, end_x, end_y`) and standardized `105×68` FIFA coordinates (`x_105, y_105, end_x_105, end_y_105`), calibrated `xg`, pass lengths/angles, progressive pass/carry flags, box entries, defensive actions, high turnovers, counterpress markers, `under_pressure`, `has_freeze_frame`, and live `match_state` (`winning`, `drawing`, `losing`).

### Coordinate Transformations
Every spatial action is mapped deterministically between coordinate grids:
- **StatsBomb (`120×80`) → FIFA (`105×68`)**:
  $$x_{105} = x_{120} \times \frac{105}{120}, \quad y_{68} = y_{80} \times \frac{68}{80}$$
- **Opta / Wyscout (`100×100`) → StatsBomb (`120×80`)**:
  $$x_{120} = x_{100} \times \frac{120}{100}, \quad y_{80} = (100 - y_{100}) \times \frac{80}{100}$$
- **Understat (`1×1`) → StatsBomb (`120×80`)**:
  $$x_{120} = x_{1} \times 120, \quad y_{80} = y_{1} \times 80$$

---

## 3. Normalization & Tactical Metric Definitions

- **Per-90 Normalization (`per_90`)**:
  $$\text{Metric}_{90} = \frac{\text{Raw Count}}{\text{Minutes Played}} \times 90$$
- **Possession-Adjusted Normalization (`possession_adjusted` / PAdj)**:
  Applies an opponent-possession scaling factor to out-of-possession defensive and pressing actions so players in high-possession teams are compared fairly against players in low-block teams:
  $$\text{Metric}_{\text{PAdj}} = \text{Metric}_{90} \times \frac{50}{100 - \text{Team Possession \%}}$$
- **Progressive Pass**: Completed open-play pass moving the ball at least `prog_pass_min_dist` (default `10.0` meters in `105×68` space) closer to the opponent's goal center `(105, 34)` or entering the opponent penalty box (`x_105 >= 88.5` and `13.84 <= y_105 <= 54.16`).
- **PPDA (Passes Allowed Per Defensive Action)**:
  $$\text{PPDA} = \frac{\text{Opponent Completed Passes where } x_{105} \ge \text{ppda\_def\_line\_x}}{\text{Defensive Actions (Tackles + Interceptions + Pressures) where } x_{105} \ge \text{ppda\_def\_line\_x}}$$
- **High Turnover**: Ball recovery, interception, or tackle won in open play at or above `high_turnover_x_threshold` (default `x_105 >= 65.0`, i.e., within 40m of the opponent goal).

---

## 4. Five-Stage Gated Agentic Workflow

1. **Stage 1 — Intent Clarification**: Parses natural-language queries, identifies the target analytical module and entities (club, player, season, skill composite), and surfaces ambiguities (min-minutes threshold, date range, normalization) for explicit user confirmation.
2. **Stage 2 — Data Feasibility Check**: Inspects live DuckDB schema and competition coverage. **Zero-proxy guarantee**: If the request requires optical player tracking, sprint speeds, body orientation, missing 360 freeze-frames, or uningested seasons/leagues, the workflow **halts immediately** (`halted_infeasible`) and reports the exact schema gap.
3. **Stage 3 — Transparent Execution Plan**: Presents exact formulas, SQL filter scope, normalization method, coordinate grid, and statistical caveats. Pauses for user approval or inline parameter overrides.
4. **Stage 4 — Automated Verification**: Executes queries and runs 5 automated sanity checks before rendering:
   - Score parity (`matches` scores vs `events` goal shots)
   - Shot count & xG sum/bounds reconciliation (`0 < xg <= 1`)
   - Player `minutes_played` integrity (`[0, 120]` and min-minutes enforcement)
   - League baseline sanity (mean goals/match, PPDA range, possession balance)
   - Coordinate bounds (`[0, 120]×[0, 80]` and `[0, 105]×[0, 68]`)
5. **Stage 5 — Interactive Render & Assumption Override**: Renders interactive visualizations, pitch maps, data tables, and plain-English tactical takeaways paired with an editable **Assumptions & Logic** `<dialog>` drawer for immediate re-execution.
