import {
  PROVIDER_MAPPING_PRESETS,
  configureProvider,
  ingestStatsbomb,
  ingestUploadedCsv,
  listProviders,
  previewUploadedFile,
} from "./adapters";
import { DEFAULT_ASSUMPTIONS, executeModule, runAutomatedVerification } from "./analytics";
import { getDatasetStore, inspectDatabaseCapabilities } from "./data";
import type { Env, ModuleId } from "./types";
import {
  WorkflowBadStateError,
  WorkflowNotFoundError,
  approveStage2BuildPlan,
  approveStage3ExecuteAndVerify,
  approveStage4Render,
  confirmStage1AndCheckFeasibility,
  getWorkflowSession,
  overrideAssumptionsAndRerun,
  startWorkflowSession,
} from "./workflow";

const ALLOWED_ORIGINS = new Set(["https://martindavies-code.github.io"]);

function isAllowedOrigin(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) return true;
  if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
    return true;
  }
  return false;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowOrigin = isAllowedOrigin(origin, env) ? (origin as string) : "https://martindavies-code.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  };
}

function jsonResponse(request: Request, env: Env, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

async function readJsonBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    try {
      // Health & Schema Endpoints
      if (path === "/api/health" && method === "GET") {
        const store = await getDatasetStore(env);
        const caps = inspectDatabaseCapabilities(store);
        return jsonResponse(request, env, {
          status: "ok",
          table_counts: caps.table_counts,
          seasons: caps.seasons,
        });
      }

      if (path === "/api/schema/capabilities" && method === "GET") {
        const store = await getDatasetStore(env);
        return jsonResponse(request, env, inspectDatabaseCapabilities(store));
      }

      if (path === "/api/defaults" && method === "GET") {
        return jsonResponse(request, env, {
          assumptions: DEFAULT_ASSUMPTIONS,
          mapping_presets: PROVIDER_MAPPING_PRESETS,
        });
      }

      // 5-Stage Gated Agentic Workflow Endpoints
      if (path === "/api/workflow/start" && method === "POST") {
        const body = await readJsonBody<{ prompt?: string }>(request);
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (prompt.length < 2) {
          return jsonResponse(request, env, { detail: "Field 'prompt' must be at least 2 characters." }, 422);
        }
        const store = await getDatasetStore(env);
        const session = await startWorkflowSession(env, store, prompt);
        return jsonResponse(request, env, session);
      }

      const workflowMatch = path.match(/^\/api\/workflow\/([^/]+)(?:\/([^/]+))?$/);
      if (workflowMatch) {
        const sessionId = decodeURIComponent(workflowMatch[1]);
        const action = workflowMatch[2] || "";

        if (!action && method === "GET") {
          try {
            const session = await getWorkflowSession(env, sessionId);
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return jsonResponse(request, env, { detail: "Workflow session not found" }, 404);
            }
            throw err;
          }
        }

        if (action === "stage-1-confirm" && method === "POST") {
          const body = await readJsonBody<{ clarifications?: Record<string, unknown> }>(request);
          const store = await getDatasetStore(env);
          try {
            const session = await confirmStage1AndCheckFeasibility(
              env,
              store,
              sessionId,
              body.clarifications ?? {}
            );
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return jsonResponse(request, env, { detail: err.message }, 404);
            }
            throw err;
          }
        }

        if (action === "stage-2-approve" && method === "POST") {
          try {
            const session = await approveStage2BuildPlan(env, sessionId);
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return jsonResponse(request, env, { detail: err.message }, 404);
            }
            if (err instanceof WorkflowBadStateError) {
              return jsonResponse(request, env, { detail: err.message }, 400);
            }
            throw err;
          }
        }

        if (action === "stage-3-approve" && method === "POST") {
          const body = await readJsonBody<{ param_edits?: Record<string, unknown> }>(request);
          const store = await getDatasetStore(env);
          try {
            const session = await approveStage3ExecuteAndVerify(env, store, sessionId, body.param_edits ?? {});
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return jsonResponse(request, env, { detail: err.message }, 404);
            }
            throw err;
          }
        }

        if (action === "stage-4-approve" && method === "POST") {
          try {
            const session = await approveStage4Render(env, sessionId);
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError || err instanceof WorkflowBadStateError) {
              return jsonResponse(request, env, { detail: err.message }, 400);
            }
            throw err;
          }
        }

        if (action === "override-assumptions" && method === "POST") {
          const body = await readJsonBody<{ assumptions?: Record<string, unknown> }>(request);
          const store = await getDatasetStore(env);
          try {
            const session = await overrideAssumptionsAndRerun(env, store, sessionId, body.assumptions ?? {});
            return jsonResponse(request, env, session);
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              return jsonResponse(request, env, { detail: err.message }, 404);
            }
            throw err;
          }
        }
      }

      // Direct Standalone Module Execution
      const moduleMatch = path.match(/^\/api\/modules\/([^/]+)\/run$/);
      if (moduleMatch && method === "POST") {
        const moduleId = decodeURIComponent(moduleMatch[1]) as ModuleId;
        const body = await readJsonBody<{ overrides?: Record<string, unknown> }>(request);
        const store = await getDatasetStore(env);
        try {
          const result = executeModule(store, moduleId, body.overrides ?? {});
          const verification = runAutomatedVerification(
            store,
            moduleId,
            result.assumptions as unknown as Record<string, unknown>,
            result
          );
          return jsonResponse(request, env, {
            module_id: moduleId,
            result,
            verification,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResponse(request, env, { detail: msg }, 400);
        }
      }

      // Data Layer & Plug-and-Play Adapters
      if (path === "/api/adapters/statsbomb/ingest" && method === "POST") {
        const body = await readJsonBody<{
          mode?: string;
          reset?: boolean;
          competition_id?: number;
          season_id?: number;
          max_matches?: number;
        }>(request);
        const store = await getDatasetStore(env);
        const { ingest, store: updatedStore } = await ingestStatsbomb(env, store, {
          mode: body.mode ?? "canonical",
          reset: body.reset ?? true,
          competition_id: Number(body.competition_id ?? 2),
          season_id: Number(body.season_id ?? 27),
          max_matches: Number(body.max_matches ?? 3),
        });
        return jsonResponse(request, env, {
          ingest,
          capabilities: inspectDatabaseCapabilities(updatedStore),
        });
      }

      if (path === "/api/adapters/upload-preview" && method === "POST") {
        try {
          const form = await request.formData();
          const fileEntry = form.get("file");
          if (!fileEntry || typeof fileEntry === "string") {
            return jsonResponse(request, env, { detail: "Missing uploaded file field 'file'." }, 400);
          }
          const buf = await fileEntry.arrayBuffer();
          return jsonResponse(request, env, previewUploadedFile(buf, fileEntry.name || "upload.csv"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResponse(request, env, { detail: msg }, 400);
        }
      }

      if (path === "/api/adapters/upload-ingest" && method === "POST") {
        try {
          const form = await request.formData();
          const fileEntry = form.get("file");
          if (!fileEntry || typeof fileEntry === "string") {
            return jsonResponse(request, env, { detail: "Missing uploaded file field 'file'." }, 400);
          }
          const mappingJson = String(form.get("mapping_json") || "{}");
          const coordSystem = String(form.get("coord_system") || "100x100");
          const dataSource = String(form.get("data_source") || "custom_upload");
          const seasonName = String(form.get("season_name") || "2024/2025");
          const competitionName = String(form.get("competition_name") || "Imported Feed");

          const mapping = JSON.parse(mappingJson) as Record<string, string>;
          const buf = await fileEntry.arrayBuffer();
          const store = await getDatasetStore(env);
          const { ingest, store: updatedStore } = await ingestUploadedCsv(
            env,
            store,
            buf,
            fileEntry.name || "upload.csv",
            mapping,
            coordSystem,
            dataSource,
            seasonName,
            competitionName
          );
          return jsonResponse(request, env, {
            ingest,
            capabilities: inspectDatabaseCapabilities(updatedStore),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResponse(request, env, { detail: msg }, 400);
        }
      }

      if (path === "/api/adapters/providers" && method === "GET") {
        const providers = await listProviders(env);
        return jsonResponse(request, env, { providers });
      }

      if (path === "/api/adapters/providers/configure" && method === "POST") {
        const body = await readJsonBody<{ provider_id?: string; api_key?: string; base_url?: string }>(request);
        try {
          const res = await configureProvider(
            env,
            String(body.provider_id || ""),
            String(body.api_key || ""),
            body.base_url ?? null
          );
          return jsonResponse(request, env, res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonResponse(request, env, { detail: msg }, 400);
        }
      }

      return jsonResponse(request, env, { detail: "Not found" }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(request, env, { error: msg, detail: msg }, 500);
    }
  },
};
