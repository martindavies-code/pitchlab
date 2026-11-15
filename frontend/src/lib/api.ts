import type {
  AssumptionsConfig,
  DatabaseCapabilities,
  ModuleId,
  ModuleResultPayload,
  ProviderDescriptor,
  VerificationReport,
  WorkflowSession,
} from "./types";

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const pitchlabApi = {
  getCapabilities: () => apiFetch<DatabaseCapabilities>("/api/schema/capabilities"),

  runModule: (moduleId: ModuleId, overrides: Partial<AssumptionsConfig> = {}) =>
    apiFetch<{ module_id: ModuleId; result: ModuleResultPayload; verification: VerificationReport }>(
      `/api/modules/${moduleId}/run`,
      { method: "POST", body: JSON.stringify({ overrides }) }
    ),

  startWorkflow: (prompt: string) =>
    apiFetch<WorkflowSession>("/api/workflow/start", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),

  confirmStage1: (sessionId: string, clarifications: Partial<AssumptionsConfig>) =>
    apiFetch<WorkflowSession>(`/api/workflow/${sessionId}/stage-1-confirm`, {
      method: "POST",
      body: JSON.stringify({ clarifications }),
    }),

  approveStage2: (sessionId: string) =>
    apiFetch<WorkflowSession>(`/api/workflow/${sessionId}/stage-2-approve`, {
      method: "POST",
    }),

  approveStage3: (sessionId: string, paramEdits: Partial<AssumptionsConfig>) =>
    apiFetch<WorkflowSession>(`/api/workflow/${sessionId}/stage-3-approve`, {
      method: "POST",
      body: JSON.stringify({ param_edits: paramEdits }),
    }),

  approveStage4: (sessionId: string) =>
    apiFetch<WorkflowSession>(`/api/workflow/${sessionId}/stage-4-approve`, {
      method: "POST",
    }),

  overrideAssumptions: (sessionId: string, assumptions: Partial<AssumptionsConfig>) =>
    apiFetch<WorkflowSession>(`/api/workflow/${sessionId}/override-assumptions`, {
      method: "POST",
      body: JSON.stringify({ assumptions }),
    }),

  ingestStatsbomb: (payload: {
    mode: "canonical" | "github";
    reset?: boolean;
    competition_id?: number;
    season_id?: number;
    max_matches?: number;
  }) =>
    apiFetch<{ ingest: Record<string, any>; capabilities: DatabaseCapabilities }>(
      "/api/adapters/statsbomb/ingest",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  uploadPreview: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<{
      filename: string;
      row_count: number;
      columns: string[];
      suggested_preset: string;
      presets: Record<string, { coord_system: string; columns: Record<string, string> }>;
      sample_rows: Array<Record<string, any>>;
    }>("/api/adapters/upload-preview", { method: "POST", body: fd });
  },

  uploadIngest: (payload: {
    file: File;
    mapping: Record<string, string>;
    coordSystem: string;
    dataSource: string;
    seasonName: string;
    competitionName: string;
  }) => {
    const fd = new FormData();
    fd.append("file", payload.file);
    fd.append("mapping_json", JSON.stringify(payload.mapping));
    fd.append("coord_system", payload.coordSystem);
    fd.append("data_source", payload.dataSource);
    fd.append("season_name", payload.seasonName);
    fd.append("competition_name", payload.competitionName);
    return apiFetch<{ ingest: Record<string, any>; capabilities: DatabaseCapabilities }>(
      "/api/adapters/upload-ingest",
      { method: "POST", body: fd }
    );
  },

  listProviders: () => apiFetch<{ providers: ProviderDescriptor[] }>("/api/adapters/providers"),

  configureProvider: (provider_id: string, api_key: string, base_url?: string) =>
    apiFetch<{ health: Record<string, any>; providers: ProviderDescriptor[] }>(
      "/api/adapters/providers/configure",
      { method: "POST", body: JSON.stringify({ provider_id, api_key, base_url }) }
    ),
};
