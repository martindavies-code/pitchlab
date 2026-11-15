# PitchLab Studio Deployment Guide

## Live Endpoints

- **Frontend (GitHub Pages):** https://martindavies-code.github.io/pitchlab/
- **Backend API (Cloudflare Worker):** https://pitchlab-api.martin-davies.workers.dev
- **GitHub Repository:** https://github.com/martindavies-code/pitchlab

## Architecture & Provisioned Resources

| Component | Service | Details |
| :--- | :--- | :--- |
| Frontend (`frontend/`) | GitHub Pages | Static Next.js export (`NEXT_EXPORT=true`, `NEXT_PUBLIC_BASE_PATH=/pitchlab`), built with `NEXT_PUBLIC_API_URL=https://pitchlab-api.martin-davies.workers.dev` |
| Backend API (`worker/`) | Cloudflare Workers | Worker `pitchlab-api` on `martin-davies.workers.dev` (`compatibility_date = "2026-11-15"`, `nodejs_compat`, Workers Logs & Traces observability enabled) |
| Data & Session Store | Cloudflare Workers KV | Binding `PITCHLAB_KV` (`id = "5d3492ba4198457bab510811fdff0ef1"`), populated with `180` matches, `10` teams, `150` players, `5,400` lineups, and `47,003` events across 9 chunked dataset entries |

## GitHub Actions & Secrets Configuration

- **Repository Variable:** `NEXT_PUBLIC_API_URL` is set to `https://pitchlab-api.martin-davies.workers.dev`.
- **GitHub Pages:** Configured with `build_type: workflow` and HTTPS enforced.
- **Automated Worker Deploys (Optional):** In `.github/workflows/deploy.yml`, the `deploy-worker` job checks for `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
  - When those secrets are absent, `deploy-worker` emits a notice and skips `wrangler-action` so `deploy-pages` still deploys frontend updates.
  - To enable automated Worker deploys on pushes to `main`, add `CLOUDFLARE_API_TOKEN` (with Workers Scripts Edit and Workers KV Storage Edit permissions) and `CLOUDFLARE_ACCOUNT_ID` (`0ab3b1761e059d30de105dc2f5c4ee21`) under **Settings → Secrets and variables → Actions**.

## Manual Re-Deploy & KV Refresh Commands

### Re-export and Upload Dataset to Remote KV
Run from the repository root:

```powershell
.\.venv\Scripts\python.exe worker\scripts\export-kv-data.py
Set-Location worker
node scripts\upload-kv.mjs --remote
```

### Deploy the Cloudflare Worker Manually
Run from `worker/` (authenticated via `npx wrangler login`):

```powershell
npx --yes wrangler@4.162.0 deploy
```

> **Note for Windows + Google Drive workspaces:** Running `npm install` directly inside `G:\My Drive\...` can fail on tar extraction (`TAR_ENTRY_ERROR` / `EBADF`). Use `npx --yes wrangler@4.162.0 ...` directly or stage `node_modules` on a local NTFS drive (`C:\`).
