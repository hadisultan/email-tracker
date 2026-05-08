import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { _resetServiceRoleClientForTests } from '../lib/supabase.js';
import { sha256Hex } from '../lib/auth.js';

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;

const { default: beacon } = await import('../beacon.js');

interface ErrorBody {
  error: { code: string; message: string };
}

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const TOKEN = 'et_test-beacon-token';
const TOKEN_HASH = sha256Hex(TOKEN);
const OWNED_THREAD = 'thread-owned-1';
const FOREIGN_THREAD = 'thread-foreign-zzz';

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
    VALUES (${SEED_USER_ID}, ${TOKEN_HASH}, 'beacon-test')
    ON CONFLICT (token_hash) DO NOTHING
  `;
  // Seed an owned message so the ownership check has something to find.
  await sql`
    INSERT INTO public.messages (user_id, token, client_send_id, subject, recipients, gmail_thread_id, sent_at)
    VALUES (
      ${SEED_USER_ID},
      ${'tok-' + Math.random().toString(36).slice(2)},
      gen_random_uuid(),
      'beacon-seed',
      ARRAY['a@x.com'],
      ${OWNED_THREAD},
      now()
    )
  `;
  // Commit barrier.
  const direct = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM public.service_tokens WHERE token_hash = ${TOKEN_HASH}
  `;
  expect(direct[0]!.count).toBe('1');
});

afterEach(async () => {
  await sql`DELETE FROM public.self_view_beacons WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.service_tokens WHERE user_id = ${SEED_USER_ID}`;
});

function postBeacon(body: unknown): Request {
  return new Request('http://localhost/api/beacon', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('beacon handler', () => {
  it('returns 401 when no Authorization header', async () => {
    const req = new Request('http://localhost/api/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gmail_thread_id: OWNED_THREAD }),
    });
    const res = await beacon(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 when gmail_thread_id is missing', async () => {
    const res = await beacon(postBeacon({}), ctx);
    expect(res.status).toBe(400);
    const body = await jsonAs<ErrorBody>(res);
    expect(body.error.code).toBe('bad_request');
  });

  it('returns 204 and inserts a row when thread is owned by caller', async () => {
    const res = await beacon(postBeacon({ gmail_thread_id: OWNED_THREAD }), ctx);
    expect(res.status).toBe(204);

    const rows = await sql<{ gmail_thread_id: string | null }[]>`
      SELECT gmail_thread_id FROM public.self_view_beacons WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.gmail_thread_id).toBe(OWNED_THREAD);
  });

  it('returns 204, drops silently, and warns when thread is foreign', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await beacon(postBeacon({ gmail_thread_id: FOREIGN_THREAD }), ctx);
    expect(res.status).toBe(204);

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.self_view_beacons WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows[0]!.count).toBe('0');

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls[0]![0] as string;
    const parsed = JSON.parse(logged) as Record<string, unknown>;
    expect(parsed.source).toBe('beacon');
    expect(parsed.stage).toBe('foreign-thread');
    expect(parsed.user_id).toBe(SEED_USER_ID);
    expect(parsed.thread_id).toBe(FOREIGN_THREAD);

    warn.mockRestore();
  });

  it('accepts repeated beacons for the same owned thread (multiple rows)', async () => {
    await beacon(postBeacon({ gmail_thread_id: OWNED_THREAD }), ctx);
    await beacon(postBeacon({ gmail_thread_id: OWNED_THREAD }), ctx);
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.self_view_beacons WHERE user_id = ${SEED_USER_ID}
    `;
    expect(rows[0]!.count).toBe('2');
  });
});
