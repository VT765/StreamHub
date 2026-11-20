import { getDeviceKey } from './deviceKey';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

/** Gateway errors while the free-tier API host wakes from sleep (it can take ~50 s). */
const WAKING = new Set([502, 503, 504]);
const WAKE_RETRY_DELAYS_MS = [2000, 4000, 6000, 8000, 10_000, 15_000, 15_000, 15_000];

let wakeCount = 0;
function setWaking(on: boolean) {
  wakeCount = Math.max(0, wakeCount + (on ? 1 : -1));
  window.dispatchEvent(new CustomEvent('server:waking', { detail: wakeCount > 0 }));
}

async function request<T>(method: string, url: string, body?: Body, init?: RequestInit): Promise<T> {
  // Only safe-to-repeat GETs are retried while the server wakes; writes fail fast as before.
  if (method !== 'GET') return send<T>(method, url, body, init);
  let waking = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send<T>(method, url, body, init);
      } catch (err) {
        const retryable = (err instanceof ApiError && WAKING.has(err.status)) || err instanceof TypeError;
        if (!retryable || attempt >= WAKE_RETRY_DELAYS_MS.length) throw err;
        if (!waking) setWaking((waking = true));
        await new Promise((r) => setTimeout(r, WAKE_RETRY_DELAYS_MS[attempt]));
      }
    }
  } finally {
    if (waking) setWaking(false);
  }
}

async function send<T>(method: string, url: string, body?: Body, init?: RequestInit): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'include',
    headers: {
      'X-Device-Key': getDeviceKey(),
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    ...init,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && data?.code === 'UNAUTHENTICATED') window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, init?: RequestInit) => request<T>('GET', url, undefined, init),
  post: <T>(url: string, body?: Body, init?: RequestInit) => request<T>('POST', url, body, init),
  put: <T>(url: string, body?: Body) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: Body) => request<T>('PATCH', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : 'Something went wrong';
}
