import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { _resetServiceRoleClientForTests, _setAuthClientForTests } from '../lib/supabase.js';
import { sha256Hex } from '../lib/auth.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;
process.env.OWNER_EMAIL_ALLOWLIST = 'owner@example.com';

const { default: pushSubscribe } = await import('../push-subscribe.js');

const TOKEN = 'et_test-push-token';
const TOKEN_HASH = sha256Hex(TOKEN);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/test-endpoint-zzz';
const OWNER_EMAIL = 'owner@example.com';
const NON_OWNER_EMAIL = 'rando@example.com';

const fakeAuthClient = (user: { id: string; email: string } | null) =>
  ({
    auth: {
      getUser: async (_jwt: string) =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
  } as never);

let sql: Sql;
const ctx = {} as never;

beforeAll(() => {
  sql = postgres(process.env.SUPABASE_DB_URL!, { onnotice: () => {}, max: 4 });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

beforeEach(async () => {
  _resetServiceRoleClientForTests();
  _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: OWNER_EMAIL }));
  await sql`
    INSERT INTO public.service_tokens (user_id, token_hash, label)
    VALUES (${SEED_USER_ID}, ${TOKEN_HASH}, 'push-test')
    ON CONFLICT (token_hash) DO NOTHING
  `;
  const direct = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM public.service_tokens WHERE token_hash = ${TOKEN_HASH}
  `;
  expect(direct[0]!.count).toBe('1');
});

afterEach(async () => {
  _setAuthClientForTests(null);
  await sql`DELETE FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.service_tokens WHERE user_id = ${SEED_USER_ID}`;
});

function postSub(body: unknown, token = TOKEN): Request {
  return new Request('http://localhost/api/push-subscribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  endpoint: ENDPOINT,
  keys: { p256dh: 'p256dh-original', auth: 'auth-original' },
};

describe('push-subscribe handler', () => {
  it('returns 401 when no Authorization header', async () => {
    const req = new Request('http://localhost/api/push-subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    const res = await pushSubscribe(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is "Bearer " with empty token after trim', async () => {
    // The empty-bearer guard must reject before either auth path runs;
    // otherwise requireUserJwt would receive an empty token and return
    // its own 401 with a different error code, leaking which path was
    // attempted.
    const req = new Request('http://localhost/api/push-subscribe', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer    ',
        'content-type': 'application/json',
      },
      body: JSON.stringify(VALID_BODY),
    });
    const res = await pushSubscribe(req, ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_token');
  });

  it('routes case-insensitively on the et_ prefix (ET_, eT_) so a hypothetical mixed-case token still hits the service-token path)', async () => {
    // generateServiceToken always lowercases the prefix, but the
    // Bearer-extraction regex is case-insensitive — keep the prefix
    // check consistent so a hand-crafted ET_ token doesn't silently
    // hit the JWT path.
    await sql`
      INSERT INTO public.service_tokens (user_id, token_hash, label)
      VALUES (${SEED_USER_ID}, ${sha256Hex('ET_uppercase-test')}, 'upper-test')
      ON CONFLICT (token_hash) DO NOTHING
    `;
    const res = await pushSubscribe(postSub(VALID_BODY, 'ET_uppercase-test'), ctx);
    expect(res.status).toBe(200);
  });

  it('returns 400 for missing endpoint', async () => {
    const res = await pushSubscribe(
      postSub({ keys: { p256dh: 'a', auth: 'b' } }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing keys', async () => {
    const res = await pushSubscribe(postSub({ endpoint: ENDPOINT }), ctx);
    expect(res.status).toBe(400);
  });

  it('inserts a new subscription row', async () => {
    const res = await pushSubscribe(postSub(VALID_BODY), ctx);
    expect(res.status).toBe(200);

    const rows = await sql<
      { endpoint: string; p256dh: string; auth: string; user_id: string }[]
    >`SELECT endpoint, p256dh, auth, user_id FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.endpoint).toBe(ENDPOINT);
    expect(rows[0]!.p256dh).toBe('p256dh-original');
    expect(rows[0]!.auth).toBe('auth-original');
    expect(rows[0]!.user_id).toBe(SEED_USER_ID);
  });

  it('overwrites p256dh and auth when re-subscribing with the same endpoint (key rotation)', async () => {
    const r1 = await pushSubscribe(postSub(VALID_BODY), ctx);
    expect(r1.status).toBe(200);

    const rotated = {
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256dh-ROTATED', auth: 'auth-ROTATED' },
    };
    const r2 = await pushSubscribe(postSub(rotated), ctx);
    expect(r2.status).toBe(200);

    const rows = await sql<
      { endpoint: string; p256dh: string; auth: string }[]
    >`SELECT endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}`;
    // Single row with new keys.
    expect(rows.length).toBe(1);
    expect(rows[0]!.endpoint).toBe(ENDPOINT);
    expect(rows[0]!.p256dh).toBe('p256dh-ROTATED');
    expect(rows[0]!.auth).toBe('auth-ROTATED');
  });

  it('updates last_used_at on each subscribe call', async () => {
    await pushSubscribe(postSub(VALID_BODY), ctx);
    const before = await sql<{ last_used_at: Date | null }[]>`
      SELECT last_used_at FROM public.push_subscriptions WHERE endpoint = ${ENDPOINT}
    `;
    const t1 = before[0]!.last_used_at;
    expect(t1).not.toBeNull();

    await new Promise((r) => setTimeout(r, 25));
    await pushSubscribe(postSub(VALID_BODY), ctx);
    const after = await sql<{ last_used_at: Date | null }[]>`
      SELECT last_used_at FROM public.push_subscriptions WHERE endpoint = ${ENDPOINT}
    `;
    const t2 = after[0]!.last_used_at;
    expect(t2).not.toBeNull();
    expect(t2!.getTime()).toBeGreaterThan(t1!.getTime());
  });

  it('accepts a Supabase JWT for the dashboard subscribe path', async () => {
    // JWT-shaped token (no et_ prefix) routes through requireUserJwt.
    // The fake auth client returns the seed user with the owner email.
    const res = await pushSubscribe(postSub(VALID_BODY, 'eyJabc.def.ghi'), ctx);
    expect(res.status).toBe(200);

    const rows = await sql<{ endpoint: string; user_id: string }[]>`
      SELECT endpoint, user_id FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.endpoint).toBe(ENDPOINT);
    expect(rows[0]!.user_id).toBe(SEED_USER_ID);
  });

  it('rejects a JWT whose email is not in the owner allowlist', async () => {
    _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: NON_OWNER_EMAIL }));
    const res = await pushSubscribe(postSub(VALID_BODY, 'eyJabc.def.ghi'), ctx);
    expect(res.status).toBe(403);

    const rows = await sql<{ endpoint: string }[]>`
      SELECT endpoint FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows.length).toBe(0);
  });

  it('rejects a JWT that fails verification (401)', async () => {
    _setAuthClientForTests(fakeAuthClient(null));
    const res = await pushSubscribe(postSub(VALID_BODY, 'eyJbad.token.value'), ctx);
    expect(res.status).toBe(401);
  });
});
