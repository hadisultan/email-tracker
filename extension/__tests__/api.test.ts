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

describe('U6b / U6c stubs', () => {
  it('mint() throws (implemented in U6b)', async () => {
    const { mint } = await import('../src/lib/api.js');
    await expect(
      mint(
        { subject: '', recipients: ['x@y'], sent_at: new Date().toISOString() },
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toThrow(/U6b/);
  });

  it('beacon() throws (implemented in U6c)', async () => {
    const { beacon } = await import('../src/lib/api.js');
    await expect(beacon('thread-1')).rejects.toThrow(/U6c/);
  });

  it('pushSubscribe() throws (implemented in U6c)', async () => {
    const { pushSubscribe } = await import('../src/lib/api.js');
    await expect(
      pushSubscribe({ endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } }),
    ).rejects.toThrow(/U6c/);
  });
});
