#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, "..");
const kvBulkPath = resolve(workerRoot, "data", "kv-bulk.json");
const wranglerToml = resolve(workerRoot, "wrangler.toml");

const kvBulkRel = "data/kv-bulk.json";
const wranglerRel = "wrangler.toml";

if (!existsSync(kvBulkPath)) {
  console.error(`Missing ${kvBulkPath}. Run python worker/scripts/export-kv-data.py first.`);
  process.exit(1);
}

const isRemote = process.argv.includes("--remote");
const persistArgIdx = process.argv.indexOf("--persist-to");
const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
const args = [
  "--yes",
  "wrangler@4.162.0",
  "kv",
  "bulk",
  "put",
  kvBulkRel,
  "--binding",
  "PITCHLAB_KV",
  "--config",
  wranglerRel,
  isRemote ? "--remote" : "--local",
];

if (!isRemote && persistArgIdx !== -1 && process.argv[persistArgIdx + 1]) {
  args.push("--persist-to", quote(process.argv[persistArgIdx + 1]));
}

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
console.log(`Uploading ${kvBulkPath} to PITCHLAB_KV (${isRemote ? "remote" : "local"})...`);
const res = spawnSync(npxCmd, args, { stdio: "inherit", cwd: workerRoot, shell: process.platform === "win32" });
process.exit(res.status ?? 1);
