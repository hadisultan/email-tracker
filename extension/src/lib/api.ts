// Extension <-> backend API client.
//
// In U6a only `pairClaim` is implemented; `mint`, `beacon`, and
// `pushSubscribe` are stubbed so types compile and U6b/U6c can drop in
// the real bodies without changing call sites.
//
// Service-token handling: the token is read fresh from
// `chrome.storage.local` on every call. MV3 service workers are evicted
// after ~30s idle, so any in-memory cache would die with the SW. Storage
// is the single source of truth.
//
// Error model: non-2xx responses throw `ApiError(status, code, message)`.
// On 401 we proactively clear the stored token so the popup re-pair
// affordance lights up the next time the user opens it.

import { apiBase } from './config.js';

const TOKEN_KEY = 'serviceToken';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function getStoredToken(): Promise<string | null> {
  const got = await chrome.storage.local.get(TOKEN_KEY);
  const v = (got as Record<string, unknown>)[TOKEN_KEY];
  return typeof v === 'string' ? v : null;
}

export async function setStoredToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorEnvelope = {};
  try {
    body = (await res.json()) as ErrorEnvelope;
  } catch {
    // non-JSON body — keep defaults
  }
  return new ApiError(
    res.status,
    body.error?.code ?? 'unknown',
    body.error?.message ?? `HTTP ${res.status}`,
  );
}

export interface PairClaimResult {
  token: string;
}

export async function pairClaim(code: string): Promise<PairClaimResult> {
  const res = await fetch(`${apiBase()}/api/pair-extension-claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    throw await parseError(res);
  }
  const body = (await res.json()) as { token?: unknown };
  if (typeof body.token !== 'string') {
    throw new ApiError(500, 'malformed_response', 'pair-claim missing token');
  }
  await setStoredToken(body.token);
  return { token: body.token };
}

// Helper used by U6b/U6c to build authenticated requests. Returns the
// request init or throws if no token is stored — the caller can catch
// and surface a "not paired" error to the user.
export async function withAuth(
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<RequestInit> {
  const token = await getStoredToken();
  if (!token) {
    throw new ApiError(401, 'no_token', 'extension is not paired');
  }
  const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
  return { ...init, headers };
}

// === U6b / U6c stubs ===

export interface MintBody {
  subject: string;
  recipients: string[];
  gmail_thread_id?: string;
  gmail_message_id?: string;
  sent_at: string;
}

export interface MintResult {
  token: string;
  pixel_url: string;
}

export async function mint(_body: MintBody, _idempotencyKey: string): Promise<MintResult> {
  throw new Error('mint() is implemented in U6b');
}

export async function beacon(_gmailThreadId: string): Promise<void> {
  throw new Error('beacon() is implemented in U6c');
}

export interface PushSubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function pushSubscribe(_body: PushSubscribeBody): Promise<void> {
  throw new Error('pushSubscribe() is implemented in U6c');
}
