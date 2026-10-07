import type {EvolutionResult} from '../engine/types.js';

export interface FamilySummary {
  id: string;
  name: string;
  createdAt: string;
  latestRevision: number;
  versionCount: number;
  updatedAt: string;
}

export interface VersionMeta {
  revision: number;
  createdAt: string;
  createdBy: string | null;
  note: string | null;
  content: string;
}

export interface FamilyDetail {
  id: string;
  name: string;
  createdAt: string;
  versions: VersionMeta[];
}

export interface ReviewDoc {
  familyId: string;
  fromRevision: number;
  toRevision: number;
  revision: number;
  decisions: Record<string, 'confirmed' | 'rejected'>;
  updatedAt: string | null;
  updatedBy: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error((body as {message?: string}).message ?? `请求失败 ${response.status}`) as Error & {
      status: number;
      body: unknown;
    };
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export const api = {
  listFamilies: () => request<FamilySummary[]>('/api/families'),
  createFamily: (payload: {name: string; id?: string; content?: string; author?: string}) =>
    request<FamilyDetail>('/api/families', {method: 'POST', body: JSON.stringify(payload)}),
  getFamily: (id: string) => request<FamilyDetail>(`/api/families/${id}`),
  saveVersion: (
    id: string,
    payload: {content: string; expectedRevision: number; author?: string; note?: string},
  ) => request<VersionMeta>(`/api/families/${id}/versions`, {method: 'POST', body: JSON.stringify(payload)}),
  evolution: (id: string, from: number, to: number) =>
    request<EvolutionResult>(`/api/families/${id}/evolutions/${from}-${to}`),
  putReview: (
    id: string,
    fromRevision: number,
    toRevision: number,
    payload: {decisions: Record<string, 'confirmed' | 'rejected'>; baseRevision: number; author?: string},
  ) =>
    request<ReviewDoc>(
      `/api/families/${id}/reviews/${fromRevision}-${toRevision}`,
      {method: 'PUT', body: JSON.stringify(payload)},
    ),
};
