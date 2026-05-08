import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { _resetServiceRoleClientForTests } from '../lib/supabase.js';
import { sha256Hex } from '../lib/auth.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;
process.env.SITE_URL = 'http://localhost:8888';

const { default: mint } = await import('../mint.js');

interface MintBody {
  token: string;
  pixel_url: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const TOKEN = 'et_test-mint-token';
const TOKEN_HASH = sha256Hex(TOKEN);

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
  await sql`
    INSERT INTO public.service_tokens (user_id, token_hash, label)
    VALUES (${SEED_USER_ID}, ${TOKEN_HASH}, 'mint-test')
    ON CONFLICT (token_hash) DO NOTHING
  `;
  // Verifying read acts as a commit barrier between this direct INSERT and
  // the supabase-js HTTP read used by requireServiceToken.
  const direct = await sql<{ token_hash: string }[]>`
    SELECT token_hash FROM public.service_tokens WHERE token_hash = ${TOKEN_HASH}
  `;
  expect(direct.length).toBe(1);
});

afterEach(async () => {
  await sql`DELETE FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.service_tokens WHERE user_id = ${SEED_USER_ID}`;
});

function postMint(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/mint', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  subject: 'Hello there',
  recipients: ['a@example.com'],
  sent_at: '2026-01-01T12:00:00.000Z',
};

const KEY_1 = '11111111-1111-4111-8111-111111111111';
const KEY_2 = '22222222-2222-4222-8222-222222222222';

describe('mint handler: auth', () => {
  it('returns 401 when no Authorization header', async () => {
    const req = new Request('http://localhost/api/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': KEY_1 },
      body: JSON.stringify(VALID_BODY),
    });
    const res = await mint(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unrecognized token', async () => {
    const req = new Request('http://localhost/api/mint', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer et_unknown',
        'content-type': 'application/json',
        'idempotency-key': KEY_1,
      },
      body: JSON.stringify(VALID_BODY),
    });
    const res = await mint(req, ctx);
    expect(res.status).toBe(401);
  });
});

describe('mint handler: validation', () => {
  it('returns 400 idempotency_required when header missing', async () => {
    const res = await mint(postMint(VALID_BODY), ctx);
    expect(res.status).toBe(400);
    const body = await jsonAs<ErrorBody>(res);
    expect(body.error.code).toBe('idempotency_required');
  });

  it('returns 400 for empty recipients array', async () => {
    const res = await mint(
      postMint({ ...VALID_BODY, recipients: [] }, { 'idempotency-key': KEY_1 }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid sent_at', async () => {
    const res = await mint(
      postMint({ ...VALID_BODY, sent_at: 'not-a-date' }, { 'idempotency-key': KEY_1 }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe('mint handler: happy paths', () => {
  it('inserts a row and returns { token, pixel_url }', async () => {
    const res = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_1 }), ctx);
    expect(res.status).toBe(200);
    const body = await jsonAs<MintBody>(res);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(body.pixel_url).toBe(`http://localhost:8888/pixel/${body.token}`);

    const rows = await sql<
      { token: string; client_send_id: string; subject: string; recipients: string[] }[]
    >`SELECT token, client_send_id, subject, recipients FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.token).toBe(body.token);
    expect(rows[0]!.client_send_id).toBe(KEY_1);
    expect(rows[0]!.subject).toBe('Hello there');
    expect(rows[0]!.recipients).toEqual(['a@example.com']);
  });

  it('is idempotent on the Idempotency-Key header (same response, one row)', async () => {
    const a = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_1 }), ctx);
    const b = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_1 }), ctx);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ab = await jsonAs<MintBody>(a);
    const bb = await jsonAs<MintBody>(b);
    expect(bb.token).toBe(ab.token);
    expect(bb.pixel_url).toBe(ab.pixel_url);

    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.messages WHERE user_id = ${SEED_USER_ID}
    `;
    expect(count[0]!.count).toBe('1');
  });

  it('different Idempotency-Keys produce different rows and different tokens', async () => {
    const a = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_1 }), ctx);
    const b = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_2 }), ctx);
    const ab = await jsonAs<MintBody>(a);
    const bb = await jsonAs<MintBody>(b);
    expect(ab.token).not.toBe(bb.token);
    const count = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.messages WHERE user_id = ${SEED_USER_ID}
    `;
    expect(count[0]!.count).toBe('2');
  });

  it('stores multiple recipients as a single row with a text[] column', async () => {
    const res = await mint(
      postMint(
        { ...VALID_BODY, recipients: ['a@x.com', 'b@y.com', 'c@z.com'] },
        { 'idempotency-key': KEY_1 },
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    const rows = await sql<{ recipients: string[] }[]>`
      SELECT recipients FROM public.messages WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.recipients).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('truncates subjects longer than 998 chars', async () => {
    const longSubject = 'x'.repeat(2000);
    const res = await mint(
      postMint({ ...VALID_BODY, subject: longSubject }, { 'idempotency-key': KEY_1 }),
      ctx,
    );
    expect(res.status).toBe(200);
    const rows = await sql<{ subject: string }[]>`
      SELECT subject FROM public.messages WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows[0]!.subject.length).toBe(998);
  });

  it('accepts missing thread/message IDs and stores NULLs', async () => {
    const res = await mint(postMint(VALID_BODY, { 'idempotency-key': KEY_1 }), ctx);
    expect(res.status).toBe(200);
    const rows = await sql<
      { gmail_thread_id: string | null; gmail_message_id: string | null }[]
    >`SELECT gmail_thread_id, gmail_message_id FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
    expect(rows[0]!.gmail_thread_id).toBeNull();
    expect(rows[0]!.gmail_message_id).toBeNull();
  });
});
