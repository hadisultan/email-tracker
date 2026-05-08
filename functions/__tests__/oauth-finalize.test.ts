import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { _resetServiceRoleClientForTests, _setAuthClientForTests } from '../lib/supabase.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;
process.env.OWNER_EMAIL_ALLOWLIST = 'owner@example.com';

const { default: oauthFinalize } = await import('../oauth-finalize.js');

let sql: Sql;
const ownerEmail = 'owner@example.com';

const fakeAuthClient = (user: { id: string; email: string } | null) =>
  ({
    auth: {
      getUser: async (_jwt: string) =>
        user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
  } as never);

beforeAll(() => {
  sql = postgres(process.env.SUPABASE_DB_URL!, { onnotice: () => {}, max: 4 });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

beforeEach(() => {
  _resetServiceRoleClientForTests();
  _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: ownerEmail }));
});

afterEach(async () => {
  _setAuthClientForTests(null);
  await sql`DELETE FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}`;
});

const ctx = {} as never;

function postRequest(body: unknown, jwt = 'good'): Request {
  return new Request('http://localhost/api/oauth-finalize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('oauth-finalize handler', () => {
  it('rejects non-POST methods', async () => {
    const res = await oauthFinalize(
      new Request('http://localhost/api/oauth-finalize', { method: 'GET' }),
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it('returns 401 when JWT is missing', async () => {
    const req = new Request('http://localhost/api/oauth-finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_token: 't', provider_refresh_token: 'r', expires_at: 1 }),
    });
    const res = await oauthFinalize(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 403 when email is not in OWNER_EMAIL_ALLOWLIST', async () => {
    _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: 'rando@example.com' }));
    const res = await oauthFinalize(
      postRequest({ provider_token: 't', provider_refresh_token: 'r', expires_at: 1 }),
      ctx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_authorized');
  });

  it('returns 400 on a malformed body', async () => {
    const res = await oauthFinalize(postRequest({ wrong: 'shape' }), ctx);
    expect(res.status).toBe(400);
  });

  it('upserts a fresh gmail_credentials row on first sign-in', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const res = await oauthFinalize(
      postRequest({
        provider_token: 'access-1',
        provider_refresh_token: 'refresh-1',
        expires_at: expSeconds,
      }),
      ctx,
    );
    expect(res.status).toBe(200);

    const rows = await sql<
      { refresh_token: string; access_token: string; access_token_expires_at: Date }[]
    >`
      SELECT refresh_token, access_token, access_token_expires_at
      FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.refresh_token).toBe('refresh-1');
    expect(rows[0]!.access_token).toBe('access-1');
  });

  it('preserves the stored refresh_token when caller sends null on re-sign-in', async () => {
    const exp1 = Math.floor(Date.now() / 1000) + 3600;
    const r1 = await oauthFinalize(
      postRequest({
        provider_token: 'access-1',
        provider_refresh_token: 'refresh-1',
        expires_at: exp1,
      }),
      ctx,
    );
    expect(r1.status).toBe(200);

    const exp2 = exp1 + 600;
    const r2 = await oauthFinalize(
      postRequest({
        provider_token: 'access-2',
        provider_refresh_token: null,
        expires_at: exp2,
      }),
      ctx,
    );
    expect(r2.status).toBe(200);

    const rows = await sql<{ refresh_token: string; access_token: string }[]>`
      SELECT refresh_token, access_token FROM public.gmail_credentials
      WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows[0]!.refresh_token).toBe('refresh-1');
    expect(rows[0]!.access_token).toBe('access-2');
  });

  it('overwrites the refresh_token when caller sends a new value', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    await oauthFinalize(
      postRequest({
        provider_token: 'access-1',
        provider_refresh_token: 'refresh-1',
        expires_at: expSeconds,
      }),
      ctx,
    );
    await oauthFinalize(
      postRequest({
        provider_token: 'access-2',
        provider_refresh_token: 'refresh-2',
        expires_at: expSeconds,
      }),
      ctx,
    );
    const rows = await sql<{ refresh_token: string }[]>`
      SELECT refresh_token FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows[0]!.refresh_token).toBe('refresh-2');
  });
});
