import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { _resetServiceRoleClientForTests, _setAuthClientForTests } from '../lib/supabase.js';
import { normalizePairingCode, sha256Hex } from '../lib/auth.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;
process.env.OWNER_EMAIL_ALLOWLIST = 'owner@example.com';

const { default: pairCreate } = await import('../pair-extension-create.js');
const { default: pairClaim } = await import('../pair-extension-claim.js');

interface CreateBody { code: string; expires_at: string }
interface ClaimBody { token: string }
interface ErrorBody { error: { code: string; message: string } }

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

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

beforeEach(() => {
  _resetServiceRoleClientForTests();
  _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: 'owner@example.com' }));
});

afterEach(async () => {
  _setAuthClientForTests(null);
  await sql`DELETE FROM public.pairing_codes WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.service_tokens WHERE user_id = ${SEED_USER_ID}`;
});

function authedPost(url: string, body: unknown, jwt = 'good'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function unauthedPost(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('pair-extension-create', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await pairCreate(
      unauthedPost('http://localhost/api/pair-extension-create', {}),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-owner email', async () => {
    _setAuthClientForTests(fakeAuthClient({ id: SEED_USER_ID, email: 'someoneelse@example.com' }));
    const res = await pairCreate(
      authedPost('http://localhost/api/pair-extension-create', {}),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('issues a code and stores its sha256 hash', async () => {
    const res = await pairCreate(
      authedPost('http://localhost/api/pair-extension-create', {}),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await jsonAs<CreateBody>(res);
    expect(body.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const hash = sha256Hex(normalizePairingCode(body.code));
    const rows = await sql`SELECT 1 FROM public.pairing_codes WHERE code_hash = ${hash}`;
    expect(rows.length).toBe(1);
  });

  it('issues a different code on each call', async () => {
    const a = await pairCreate(
      authedPost('http://localhost/api/pair-extension-create', {}),
      ctx,
    );
    const b = await pairCreate(
      authedPost('http://localhost/api/pair-extension-create', {}),
      ctx,
    );
    const ab = await jsonAs<CreateBody>(a);
    const bb = await jsonAs<CreateBody>(b);
    expect(ab.code).not.toBe(bb.code);
  });
});

async function issueCodeViaCreate(): Promise<string> {
  const res = await pairCreate(
    authedPost('http://localhost/api/pair-extension-create', {}),
    ctx,
  );
  const body = await jsonAs<CreateBody>(res);
  return body.code;
}

describe('pair-extension-claim', () => {
  it('returns 400 on missing code', async () => {
    const res = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', {}),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 with code_invalid for an unknown code', async () => {
    const res = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code: 'AAAA-AAAA-AAAA-AAAA' }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await jsonAs<ErrorBody>(res);
    expect(body.error.code).toBe('code_invalid');
  });

  it('claims a fresh code, returns a service token, and stores its sha256', async () => {
    const code = await issueCodeViaCreate();
    const res = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code, label: 'desktop' }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await jsonAs<ClaimBody>(res);
    expect(body.token).toMatch(/^et_/);

    const tokenHash = sha256Hex(body.token);
    const rows = await sql<{ user_id: string; label: string | null }[]>`
      SELECT user_id, label FROM public.service_tokens WHERE token_hash = ${tokenHash}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.user_id).toBe(SEED_USER_ID);
    expect(rows[0]!.label).toBe('desktop');

    const consumed = await sql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM public.pairing_codes
      WHERE code_hash = ${sha256Hex(normalizePairingCode(code))}
    `;
    expect(consumed[0]!.consumed_at).not.toBeNull();
  });

  it('returns 410 code_consumed on second claim of the same code', async () => {
    const code = await issueCodeViaCreate();
    const r1 = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code }),
      ctx,
    );
    expect(r1.status).toBe(200);
    const r2 = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code }),
      ctx,
    );
    expect(r2.status).toBe(410);
    const body = await jsonAs<ErrorBody>(r2);
    expect(body.error.code).toBe('code_consumed');
  });

  it('returns 410 code_expired for a code whose expires_at is in the past', async () => {
    const code = await issueCodeViaCreate();
    await sql`
      UPDATE public.pairing_codes
      SET expires_at = now() - interval '1 minute'
      WHERE code_hash = ${sha256Hex(normalizePairingCode(code))}
    `;
    const res = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code }),
      ctx,
    );
    expect(res.status).toBe(410);
    const body = await jsonAs<ErrorBody>(res);
    expect(body.error.code).toBe('code_expired');
  });

  it('accepts a code without hyphens (normalization)', async () => {
    const code = await issueCodeViaCreate();
    const stripped = normalizePairingCode(code);
    const res = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code: stripped }),
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

describe('end-to-end pair flow', () => {
  it('lets the extension call a service-token-gated endpoint after claim', async () => {
    const code = await issueCodeViaCreate();
    const claim = await pairClaim(
      unauthedPost('http://localhost/api/pair-extension-claim', { code }),
      ctx,
    );
    const { token } = await jsonAs<ClaimBody>(claim);

    // Simulate a service-token-gated endpoint by calling requireServiceToken
    // directly with a request that bears the freshly-issued token.
    const { requireServiceToken } = await import('../lib/auth.js');
    const probe = new Request('http://localhost/api/whatever', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await requireServiceToken(probe);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.userId).toBe(SEED_USER_ID);
  });
});
