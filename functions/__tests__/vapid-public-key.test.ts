import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetServiceRoleClientForTests, _setAuthClientForTests } from '../lib/supabase.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';
process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;

const { default: vapidPublicKey } = await import('../vapid-public-key.js');

const ctx = {} as never;
const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';

const fakeAuthClient = (user: { id: string; email: string } | null) =>
  ({
    auth: {
      getUser: async (_jwt: string) =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
  }) as never;

function getReq(jwt: string | null): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request('http://localhost/api/vapid-public-key', { method: 'GET', headers });
}

beforeEach(() => {
  _resetServiceRoleClientForTests();
  _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: 'owner@example.com' }));
});

afterEach(() => {
  _setAuthClientForTests(null);
});

describe('vapid-public-key handler', () => {
  it('returns 405 on POST', async () => {
    const res = await vapidPublicKey(
      new Request('http://localhost/api/vapid-public-key', {
        method: 'POST',
        headers: { Authorization: 'Bearer good' },
      }),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await vapidPublicKey(getReq(null), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT is invalid', async () => {
    _setAuthClientForTests(fakeAuthClient(null));
    const res = await vapidPublicKey(getReq('bad-jwt'), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 500 when VAPID_PUBLIC_KEY env is unset', async () => {
    const original = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    try {
      const res = await vapidPublicKey(getReq('good'), ctx);
      expect(res.status).toBe(500);
    } finally {
      if (original !== undefined) process.env.VAPID_PUBLIC_KEY = original;
    }
  });

  it('returns 200 with the public key when JWT is valid and env is set', async () => {
    process.env.VAPID_PUBLIC_KEY = 'BNJ-test-public-key-XYZ';
    const res = await vapidPublicKey(getReq('good'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(body.publicKey).toBe('BNJ-test-public-key-XYZ');
  });
});
