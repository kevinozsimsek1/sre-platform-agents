import { identity } from "./identity";

export const API = "/_portal/api";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...identity.headers(), ...(init?.headers || {}) },
  });
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (body && (body.detail || body.message)) || `HTTP ${r.status}`);
  return body as T;
}

export const post = <T,>(path: string, data: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const put = <T,>(path: string, data: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });
