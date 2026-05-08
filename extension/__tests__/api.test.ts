import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeStub,
  makeJsonResponse,
  uninstallChromeStub,
  type ChromeStub,
} from './helpers.js';

let chromeStub: ChromeStub;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  chromeStub = installChromeStub();
  fetchSpy = vi.spyOn(globalThis, 'fetch') as never;
});

afterEach(() => {
  uninstallChromeStub();
  vi.restoreAllMocks();
});

describe('storage helpers', () => {
  it('getStoredToken returns null when no token is stored', async () => {
    const { getStoredToken } = await import('../src/lib/api.js');
    expect(await getStoredToken()).toBeNull();
  });

  it('setStoredToken / getStoredToken round-trip', async () => {
    const { getStoredToken, setStoredToken } = await import('../src/lib/api.js');
    await setStoredToken('et_abc123');
    expect(await getStoredToken()).toBe('et_abc123');
    expect(chromeStub.__backing.serviceToken).toBe('et_abc123');
  });

  it('clearStoredToken removes the token from storage', async () => {
    const { clearStoredToken, setStoredToken, getStoredToken } = await import(
      '../src/lib/api.js'
    );
    await setStoredToken('et_xyz');
    await clearStoredToken();
    expect(await getStoredToken()).toBeNull();
  });

  it('token persists across simulated SW restart (storage is the source of truth)', async () => {
    const { setStoredToken } = await import('../src/lib/api.js');
    await setStoredToken('et_persisted');

    vi.resetModules();
    const fresh = await import('../src/lib/api.js');
    expect(await fresh.getStoredToken()).toBe('et_persisted');
  });
});

describe('pairClaim', () => {
  it('POSTs to /api/pair-extension-claim and stores the returned token', async () => {
    fetchSpy.mockResolvedValue(makeJsonResponse(200, { token: 'et_new-token' }) as never);
    const { pairClaim, getStoredToken } = await import('../src/lib/api.js');

    const result = await pairClaim('AAAA-BBBB-CCCC-DDDD');

    expect(result.token).toBe('et_new-token');
    expect(await getStoredToken()).toBe('et_new-token');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8888/api/pair-extension-claim');
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    const body = JSON.parse(reqInit.body as string) as { code: string };
    expect(body.code).toBe('AAAA-BBBB-CCCC-DDDD');
  });

  it('throws ApiError(400, code_invalid) when the code is unknown', async () => {
    fetchSpy.mockResolvedValue(
      makeJsonResponse(400, {
        error: { code: 'code_invalid', message: 'pairing code not recognized' },
      }) as never,
    );
    const { pairClaim, ApiError, getStoredToken } = await import('../src/lib/api.js');

    await expect(pairClaim('NOPE-NOPE-NOPE-NOPE')).rejects.toMatchObject({
      status: 400,
      code: 'code_invalid',
    });
    expect(await getStoredToken()).toBeNull();
    await pairClaim('NOPE-NOPE-NOPE-NOPE').catch((err) => {
      expect(err).toBeInstanceOf(ApiError);
    });
  });

  it('throws ApiError(410, code_expired) when the code expired', async () => {
    fetchSpy.mockResolvedValue(
      makeJsonResponse(410, {
        error: { code: 'code_expired', message: 'pairing code expired' },
      }) as never,
    );
    const { pairClaim } = await import('../src/lib/api.js');
    await expect(pairClaim('AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      status: 410,
      code: 'code_expired',
    });
  });

  it('throws ApiError(410, code_consumed) when the code is already used', async () => {
    fetchSpy.mockResolvedValue(
      makeJsonResponse(410, {
        error: { code: 'code_consumed', message: 'pairing code already used' },
      }) as never,
    );
    const { pairClaim } = await import('../src/lib/api.js');
    await expect(pairClaim('AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      status: 410,
      code: 'code_consumed',
    });
  });

  it('throws ApiError(500, malformed_response) when the response body is missing the token field', async () => {
    fetchSpy.mockResolvedValue(makeJsonResponse(200, {}) as never);
    const { pairClaim } = await import('../src/lib/api.js');
    await expect(pairClaim('AAAA-BBBB-CCCC-DDDD')).rejects.toMatchObject({
      status: 500,
      code: 'malformed_response',
    });
  });
});

describe('withAuth', () => {
  it('attaches the bearer token from storage', async () => {
    const { setStoredToken, withAuth } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');

    const init = await withAuth({ method: 'POST', headers: { 'content-type': 'application/json' } });
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer et_authed');
    expect(headers['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('throws ApiError(401, no_token) when no token is stored', async () => {
    const { withAuth, ApiError } = await import('../src/lib/api.js');
    await expect(withAuth()).rejects.toBeInstanceOf(ApiError);
    await expect(withAuth()).rejects.toMatchObject({ status: 401, code: 'no_token' });
  });
});

describe('mint (U6b)', () => {
  const validBody = {
    subject: 'hi',
    recipients: ['a@b.com'],
    gmail_thread_id: null,
    gmail_message_id: null,
    sent_at: '2026-05-08T00:00:00.000Z',
  };
  const idem = '00000000-0000-4000-8000-000000000000';

  it('POSTs to /api/mint with bearer + idempotency-key and returns token + pixel_url', async () => {
    const { setStoredToken, mint } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        token: 'tk_abc',
        pixel_url: 'http://localhost:8888/pixel/tk_abc',
      }) as never,
    );

    const result = await mint(validBody, idem);

    expect(result).toEqual({ token: 'tk_abc', pixel_url: 'http://localhost:8888/pixel/tk_abc' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8888/api/mint');
    const reqInit = init as RequestInit & { headers: Record<string, string> };
    expect(reqInit.method).toBe('POST');
    expect(reqInit.headers['Authorization']).toBe('Bearer et_authed');
    expect(reqInit.headers['idempotency-key']).toBe(idem);
    expect(JSON.parse(reqInit.body as string)).toEqual(validBody);
  });

  it('throws ApiError(401, no_token) when not paired', async () => {
    const { mint, ApiError } = await import('../src/lib/api.js');
    await expect(mint(validBody, idem)).rejects.toBeInstanceOf(ApiError);
    await expect(mint(validBody, idem)).rejects.toMatchObject({
      status: 401,
      code: 'no_token',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears the stored token when the server returns 401', async () => {
    const { setStoredToken, mint, getStoredToken } = await import('../src/lib/api.js');
    await setStoredToken('et_stale');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } }) as never,
    );

    await expect(mint(validBody, idem)).rejects.toMatchObject({ status: 401 });
    expect(await getStoredToken()).toBeNull();
  });

  it('throws ApiError(400, idempotency_required) on backend rejection', async () => {
    const { setStoredToken, mint } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(400, {
        error: { code: 'idempotency_required', message: 'Idempotency-Key header required' },
      }) as never,
    );
    await expect(mint(validBody, idem)).rejects.toMatchObject({
      status: 400,
      code: 'idempotency_required',
    });
  });

  it('throws ApiError(500, malformed_response) when the body is missing pixel_url', async () => {
    const { setStoredToken, mint } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(makeJsonResponse(200, { token: 'tk_abc' }) as never);
    await expect(mint(validBody, idem)).rejects.toMatchObject({
      status: 500,
      code: 'malformed_response',
    });
  });

  it('forwards an AbortSignal to fetch', async () => {
    const { setStoredToken, mint } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, { token: 't', pixel_url: 'u' }) as never,
    );
    const ac = new AbortController();
    await mint(validBody, idem, ac.signal);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(ac.signal);
  });
});

describe('beacon (U6c)', () => {
  it('POSTs to /api/beacon with bearer + JSON body and resolves on 204', async () => {
    const { setStoredToken, beacon } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }) as never);

    await beacon('thread-123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:8888/api/beacon');
    const reqInit = init as RequestInit & { headers: Record<string, string> };
    expect(reqInit.method).toBe('POST');
    expect(reqInit.headers['Authorization']).toBe('Bearer et_authed');
    expect(reqInit.headers['content-type']).toBe('application/json');
    expect(JSON.parse(reqInit.body as string)).toEqual({
      gmail_thread_id: 'thread-123',
    });
  });

  it('throws ApiError(401, no_token) when not paired', async () => {
    const { beacon, ApiError } = await import('../src/lib/api.js');
    await expect(beacon('thread-1')).rejects.toBeInstanceOf(ApiError);
    await expect(beacon('thread-1')).rejects.toMatchObject({
      status: 401,
      code: 'no_token',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears the stored token when the server returns 401', async () => {
    const { setStoredToken, beacon, getStoredToken } = await import(
      '../src/lib/api.js'
    );
    await setStoredToken('et_stale');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(401, { error: { code: 'unauthorized', message: 'bad token' } }) as never,
    );

    await expect(beacon('thread-1')).rejects.toMatchObject({ status: 401 });
    expect(await getStoredToken()).toBeNull();
  });

  it('throws ApiError on 5xx without clearing the token', async () => {
    const { setStoredToken, beacon, getStoredToken } = await import(
      '../src/lib/api.js'
    );
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(
      makeJsonResponse(500, {
        error: { code: 'internal_error', message: 'oops' },
      }) as never,
    );
    await expect(beacon('thread-1')).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    });
    expect(await getStoredToken()).toBe('et_authed');
  });

  it('forwards an AbortSignal to fetch', async () => {
    const { setStoredToken, beacon } = await import('../src/lib/api.js');
    await setStoredToken('et_authed');
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }) as never);
    const ac = new AbortController();
    await beacon('thread-1', ac.signal);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(ac.signal);
  });
});

describe('pushSubscribe (dashboard-owned)', () => {
  it('throws — not implemented in the extension', async () => {
    const { pushSubscribe } = await import('../src/lib/api.js');
    await expect(
      pushSubscribe({ endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } }),
    ).rejects.toThrow(/dashboard/);
  });
});
