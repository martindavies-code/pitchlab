# PitchLab Studio

Local-first football analytics platform and gated conversational app builder powered by **Next.js (TypeScript)**, **Python FastAPI**, **DuckDB**, and **interactive dual-coordinate SVG pitch visualizations (`120×80` & `105×68`)**.

## Quick Start

### 1. Backend Setup & Seed DuckDB
```powershell
.\.venv\Scripts\python.exe -m backend.adapters.statsbomb_loader --mode canonical
.\.venv\Scripts\pytest.exe -v
.\.venv\Scripts\uvicorn.exe backend.main:app --host 127.0.0.1 --port 8000
```

### 2. Frontend Studio
```powershell
cd frontend
npm start
```

Open `http://127.0.0.1:3000` in your browser.
