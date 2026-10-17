const isDevelopment = import.meta.env.DEV;

function inferApiUrl() {
  if (typeof window === 'undefined') {
    return isDevelopment ? 'http://localhost:8000' : '';
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:8000`;
  }

  if (hostname.endsWith('.ts.net')) {
    return `${protocol}//${hostname}:8443`;
  }

  return isDevelopment ? 'http://localhost:8000' : '';
}

export const API_URL = import.meta.env.VITE_API_URL || inferApiUrl();
export const WS_URL = import.meta.env.VITE_WS_URL || (API_URL ? API_URL.replace(/^http/, 'ws') : '');

export function openStoreSocket(storeId: string, token: string) {
  if (!WS_URL) {
    throw new Error('This web release is missing its secure cloud connection URL. Contact your Store Listen administrator.');
  }
  const url = new URL(`${WS_URL.replace(/\/+$/, '')}/ws/stores/${encodeURIComponent(storeId)}`);
  if (token) url.searchParams.set('token', token);
  return new WebSocket(url.toString(), token ? ['storelisten.v1', token] : ['storelisten.v1']);
}
const TOKEN_KEY = 'sl_token';
const REQUEST_TIMEOUT_MS = 20_000;
const WAKE_TIMEOUT_MS = 90_000;
export const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 45_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    throw new Error('This browser cannot store the sign-in session. Enable site storage and try again.');
  }
}

export function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be disabled; the caller still proceeds with sign-out navigation.
  }
}

async function fetchApi(path: string, options: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  if (!API_URL) {
    throw new ApiError('This web release is missing its cloud API URL. Contact your Store Listen administrator.', 0, undefined, 'CONFIGURATION_ERROR');
  }
  const headers = new Headers(options.headers);
  const token = getToken();
  headers.set('Accept', 'application/json');
  if (typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

  const controller = new AbortController();
  const callerSignal = options.signal;
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    return await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    if (timedOut) throw new ApiError('The request timed out. Please try again.', 0, undefined, 'TIMEOUT');
    if (callerSignal?.aborted) throw cause;
    if (cause instanceof TypeError) {
      throw new ApiError('Unable to reach the Store Listen API. Check the connection and try again.', 0, undefined, 'NETWORK_ERROR');
    }
    throw cause;
  } finally {
    globalThis.clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
    return undefined;
  }
  const messages = value
    .map((item) => item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string' ? item.msg : '')
    .filter(Boolean);
  return messages.length ? messages.slice(0, 3).join('; ') : undefined;
}

async function throwResponseError(response: Response, fallback: string): Promise<never> {
  let payload: unknown;
  const contentType = response.headers.get('content-type') ?? '';
  try {
    payload = contentType.includes('json') ? await response.json() : await response.text();
  } catch {
    payload = undefined;
  }
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const message = errorMessage(body?.detail) ?? errorMessage(body) ?? (typeof payload === 'string' ? payload.slice(0, 240) : undefined) ?? `${fallback} (${response.status})`;
  throw new ApiError(
    message,
    response.status,
    response.headers.get('x-request-id') ?? (typeof body?.request_id === 'string' ? body.request_id : undefined),
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError('The API returned an unreadable response.', response.status, response.headers.get('x-request-id') ?? undefined, 'INVALID_RESPONSE');
  }
}

function redirectAfterUnauthorized(path: string, response: Response) {
  if (response.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/login')) {
    clearToken();
    window.location.href = '/login';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetchApi(path, options);
  redirectAfterUnauthorized(path, response);
  if (!response.ok) await throwResponseError(response, 'Request failed');
  return readJson<T>(response);
}

export const apiGet = <T>(path: string, options?: Pick<RequestInit, 'signal'>) => request<T>(path, options);

/** Wake a cold Render free-tier API before Live Monitor / ops calls. */
export async function wakeApi(signal?: AbortSignal): Promise<boolean> {
  if (!API_URL) return false;
  try {
    const response = await fetchApi('/health', { signal }, WAKE_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

export async function apiGetWithRetry<T>(
  path: string,
  options?: Pick<RequestInit, 'signal'>,
  attempts = 4,
): Promise<T> {
  const signal = options?.signal ?? undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      if (attempt === 0) await wakeApi(signal);
      return await request<T>(path, { ...options, signal });
    } catch (cause) {
      lastError = cause;
      const retryable = cause instanceof ApiError
        && (cause.code === 'NETWORK_ERROR' || cause.code === 'TIMEOUT' || cause.status >= 500 || cause.status === 0);
      if (!retryable || attempt === attempts - 1) throw cause;
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(1500 * (attempt + 1), 6000)));
    }
  }
  throw lastError;
}
export async function apiPost<T>(path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetchApi(
    path,
    { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) },
    timeoutMs,
  );
  redirectAfterUnauthorized(path, response);
  if (!response.ok) {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new ApiError(
        'The Store Listen API is starting up. Wait a few seconds and try again.',
        response.status,
        response.headers.get('x-request-id') ?? undefined,
        'SERVICE_UNAVAILABLE',
      );
    }
    await throwResponseError(response, 'Request failed');
  }
  return readJson<T>(response);
}

/** Wake a cold free-tier API, then POST with retries (login / critical ops). */
export async function apiPostWithWake<T>(
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt === 0) await wakeApi();
      return await apiPost<T>(path, body, timeoutMs);
    } catch (cause) {
      lastError = cause;
      const retryable = cause instanceof ApiError
        && (
          cause.code === 'NETWORK_ERROR'
          || cause.code === 'TIMEOUT'
          || cause.code === 'SERVICE_UNAVAILABLE'
          || cause.status >= 500
          || cause.status === 0
        );
      if (!retryable || attempt === attempts - 1) {
        if (cause instanceof ApiError && (cause.code === 'NETWORK_ERROR' || cause.status === 0)) {
          throw new ApiError(
            'The Store Listen API is waking up (free tier). Wait ~30s and sign in again.',
            0,
            undefined,
            'NETWORK_ERROR',
          );
        }
        throw cause;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(2000 * (attempt + 1), 8000)));
    }
  }
  throw lastError;
}
export const apiPatch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T>(path: string) => request<T>(path, { method: 'DELETE' });
export const BULK_DELETE_TIMEOUT_MS = 120_000;

export async function apiUpload<T>(path: string, form: FormData, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetchApi(path, { method: 'POST', body: form }, timeoutMs);
  redirectAfterUnauthorized(path, response);
  if (!response.ok) await throwResponseError(response, 'Upload failed');
  return readJson<T>(response);
}

export async function apiBlob(path: string): Promise<Blob> {
  const response = await fetchApi(path, { headers: { Accept: 'audio/*, application/json' } });
  redirectAfterUnauthorized(path, response);
  if (!response.ok) await throwResponseError(response, 'Audio request failed');
  return response.blob();
}

export type Store = {
  id: string;
  name: string;
  city: string;
  region: string;
  timezone: string;
  online: boolean;
  device_connected: boolean;
  open_conversations: number;
  employees: number;
  device?: {
    id: string;
    name: string;
    status: string;
    audio_status: string;
    microphone_status: string;
    stream_status: string;
    processing_latency_ms: number;
    version: string;
  } | null;
};

export type Conversation = {
  id: string;
  store_id: string;
  store_name?: string;
  started_at: string;
  status: 'LIVE' | 'ENDED';
  language: string;
  product: string | null;
  customer_intent: string | null;
  salesperson: string;
  opportunity_status: string;
};

export type Opportunity = {
  id: string;
  store_id: string;
  conversation_id?: string;
  customer_intent: string;
  product: string;
  status: 'OPEN' | 'CONVERTED' | 'MISSED' | 'UNKNOWN' | 'REVIEW_REQUIRED';
  confidence: number;
  recommendation: string;
  created_at: string;
  manager_note?: string | null;
};

export type Alert = {
  id: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
  store_id: string | null;
  created_at: string;
};

export type DashboardSummary = {
  dataMode: string;
  stores: Store[];
  metrics: {
    active_stores: number;
    online_stores: number;
    offline_stores: number;
    live_conversations: number;
    conversations_today: number;
    total_conversations?: number;
    analyzed_conversations?: number;
    potential_missed_opportunities: number;
    sales_opportunities: number;
    converted_opportunities: number;
    conversion_rate: number;
    average_response_time_seconds: number | null;
    language_distribution: Record<string, number>;
    conversation_trend: number[];
    conversation_trend_dates?: string[];
    missed_by_category?: Record<string, number>;
    manager_review_required?: number;
    pos_correlated: number;
    sales_count_7d: number;
    revenue_by_currency_7d: Record<string, number>;
    listening_seconds_7d: number;
    recorders_online: number;
    recorders_total: number;
  };
  recent_conversations: Conversation[];
  opportunities: Opportunity[];
  alerts: Alert[];
  recommendations?: { id: string; title: string; message: string; confidence: number }[];
  store_performance?: { store_id: string; conversations: number; conversion_rate: number }[];
};
