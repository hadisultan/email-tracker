// Thin typed wrappers over the Netlify functions called by the
// dashboard. Each one resolves the current Supabase JWT, posts to the
// /api/<name> route, and either returns the parsed JSON body or throws
// a descriptive Error.

import { getJwt } from './supabase.js';

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jwt = await getJwt();
  if (!jwt) throw new ApiError('not signed in', 401, 'no_session');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${jwt}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body — fall through to status-based error */
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? null);
  }
  return parsed as T;
}

export interface OAuthFinalizeBody {
  provider_token: string;
  provider_refresh_token: string | null;
  expires_at: number;
}

export async function finalizeOAuth(body: OAuthFinalizeBody): Promise<{ ok: true }> {
  const res = await authedFetch('/api/oauth-finalize', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(res);
}

export interface PairingCodeResponse {
  code: string;
  expires_at: string;
}

export async function createPairingCode(): Promise<PairingCodeResponse> {
  const res = await authedFetch('/api/pair-extension-create', {
    method: 'POST',
    body: '{}',
  });
  return readJsonOrThrow(res);
}

export async function getVapidPublicKey(): Promise<{ publicKey: string }> {
  const res = await authedFetch('/api/vapid-public-key', { method: 'GET' });
  return readJsonOrThrow(res);
}

export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function postPushSubscription(body: PushSubscribeBody): Promise<{ ok: true }> {
  const res = await authedFetch('/api/push-subscribe', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readJsonOrThrow(res);
}
