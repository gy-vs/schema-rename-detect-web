/** 前端 API 客户端：字段形状与 src/server/routes.ts 的响应保持一致 */
import type {
  CompatibilityReport,
  EffectiveDecision,
  PairAnalysis,
  Proposal,
  ReviewDecision,
  SamePathChange,
  FieldRecord,
} from '../core/types';

export interface SchemaSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  versionCount: number;
}

export interface VersionPayload {
  version: number;
  createdAt: string;
  baseVersion: number;
  content: string;
}

export interface SchemaDetail extends SchemaSummary {
  versions: VersionPayload[];
}

export interface VersionDetail extends VersionPayload {
  parseError: {message: string} | null;
  fieldCount: number;
}

export interface ReviewState {
  rev: number;
  decisions: ReviewDecision[];
  updatedAt: string;
  updatedBy?: string;
}

export interface AnalysisResponse {
  schemaId: string;
  fromVersion: number;
  toVersion: number;
  proposals: Proposal[];
  unmatchedOld: FieldRecord[];
  unmatchedNew: FieldRecord[];
  samePathChanges: SamePathChange[];
  stats: PairAnalysis['stats'];
  review: ReviewState;
  effectiveDecisions: EffectiveDecision[];
  compatibility: CompatibilityReport;
}

export interface ReviewSaveResponse extends ReviewState {
  schemaId: string;
  fromVersion: number;
  toVersion: number;
  analysis: {
    proposals: Proposal[];
    unmatchedOld: FieldRecord[];
    unmatchedNew: FieldRecord[];
    samePathChanges: SamePathChange[];
    effectiveDecisions: EffectiveDecision[];
    compatibility: CompatibilityReport;
  };
}

export interface ApiError {
  status: number;
  error: string;
  message?: string;
  payload?: unknown;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw {
      status: response.status,
      error: body?.error ?? 'request_failed',
      message: body?.message,
      payload: body,
    } satisfies ApiError;
  }
  return body as T;
}

export const api = {
  listSchemas: () => request<SchemaSummary[]>('/api/schemas'),
  getSchema: (id: string) => request<SchemaDetail>(`/api/schemas/${id}`),
  getVersion: (id: string, version: number) =>
    request<VersionDetail>(`/api/schemas/${id}/versions/${version}`),
  createSchema: (name: string, content: string) =>
    request<SchemaDetail>('/api/schemas', {method: 'POST', body: JSON.stringify({name, content})}),
  addVersion: (id: string, content: string, expectedLatest: number) =>
    request<SchemaDetail>(`/api/schemas/${id}/versions`, {
      method: 'POST',
      body: JSON.stringify({content, expectedLatest}),
    }),
  getAnalysis: (id: string, fromVersion: number, toVersion: number) =>
    request<AnalysisResponse>(
      `/api/schemas/${id}/analysis/${fromVersion}/${toVersion}?t=${Date.now()}`,
    ),
  saveReview: (
    id: string,
    fromVersion: number,
    toVersion: number,
    decisions: ReviewDecision[],
    rev: number,
    editor: string,
  ) =>
    request<ReviewSaveResponse>(
      `/api/schemas/${id}/reviews/${fromVersion}/${toVersion}`,
      {
        method: 'PUT',
        body: JSON.stringify({decisions, rev, editor}),
      },
    ),
};
