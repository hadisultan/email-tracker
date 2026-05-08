import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '@netlify/functions';

import {
  LOCAL_DB_URL,
  SEED_USER_ID,
  makeClient,
} from './db/helpers.js';
import { TRANSPARENT_GIF } from '../lib/transparent-gif.js';

// Configure env BEFORE importing the handler so the supabase client
// factory picks up the local Supabase keys.
process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??=
  // Local dev secret printed by `supabase start` - documented in
  // db/README.md and Supabase's local-dev page.
  'test-stub-service-role-key';
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;

// eslint-disable-next-line import/order, @typescript-eslint/no-unused-vars
const handlerModule = await import('../pixel.js');
const pixelHandler = handlerModule.default;

const sql = makeClient();

const KNOWN_TOKEN = 'pixeltest-known-token';
const KNOWN_THREAD = 'pixeltest-thread-A';

let knownMessageId: string;

function fakeContext(overrides: Partial<Context> = {}): Context {
  return {
    ip: '8.8.8.8',
    geo: {
      country: { name: 'United States', code: 'US' },
      city: 'Mountain View',
      latitude: 37.4,
      longitude: -122.07,
      timezone: 'America/Los_Angeles',
      subdivision: { name: 'California', code: 'CA' },
      postalCode: '94043',
    },
    requestId: 'test-request-id',
    site: { id: 'test', name: 'test', url: 'http://localhost' },
    deploy: { context: 'dev', id: 'test', published: false },
    server: { region: 'local' },
    params: {},
    cookies: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as Context['log'],
    next: async () => new Response(),
    waitUntil: () => {},
    account: { id: 'test' },
    flags: {},
    url: new URL('http://localhost/pixel/x'),
    ...overrides,
  } as unknown as Context;
}

function pixelRequest(token: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.test/pixel/${token}`, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0',
      ...headers,
    },
  });
}

beforeAll(async () => {
  await sql`SELECT 1`;
  // Use a sent_at far in the past so default tests don't accidentally
  // hit the prefetch window. Individual tests override sent_at as
  // needed via direct SQL.
  await sql`DELETE FROM public.messages WHERE token = ${KNOWN_TOKEN}`;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.messages
      (user_id, token, client_send_id, gmail_thread_id, sent_at)
    VALUES
      (${SEED_USER_ID}, ${KNOWN_TOKEN}, gen_random_uuid(),
       ${KNOWN_THREAD}, ${new Date(Date.now() - 60 * 60_000)})
    RETURNING id
  `;
  knownMessageId = inserted[0]!.id;
});

afterEach(async () => {
  await sql`DELETE FROM public.pixel_hits WHERE message_id = ${knownMessageId}`;
  await sql`DELETE FROM public.self_view_beacons WHERE user_id = ${SEED_USER_ID}`;
  // Reset sent_at to a safe-far-back value between tests.
  await sql`
    UPDATE public.messages SET sent_at = ${new Date(Date.now() - 60 * 60_000)}
    WHERE id = ${knownMessageId}
  `;
});

afterAll(async () => {
  await sql`DELETE FROM public.messages WHERE id = ${knownMessageId}`;
  await sql.end({ timeout: 5 });
});

describe('pixel handler: response shape', () => {
  it('returns 200 + image/gif + 43-byte body + no-store headers for a known token', async () => {
    const res = await pixelHandler(pixelRequest(KNOWN_TOKEN), fakeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('content-length')).toBe('43');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(43);
    expect(Array.from(body)).toEqual(Array.from(TRANSPARENT_GIF));
  });

  it('returns 200 + GIF for an unknown token, with no row inserted', async () => {
    const res = await pixelHandler(
      pixelRequest('this-token-does-not-exist'),
      fakeContext(),
    );
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(43);
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.pixel_hits
    `;
    // No rows for our known message_id - other system rows are fine.
    const ours = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]).toBeDefined();
    expect(ours[0]!.count).toBe('0');
  });

  it('returns 200 + GIF for /pixel/ with no token', async () => {
    const req = new Request('https://example.test/pixel/', { method: 'GET' });
    const res = await pixelHandler(req, fakeContext());
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(43);
    const ours = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(ours[0]!.count).toBe('0');
  });
});

describe('pixel handler: row insertion (happy path)', () => {
  it('inserts a pixel_hits row with all metadata and notify_after = hit + 90s', async () => {
    const before = Date.now();
    await pixelHandler(pixelRequest(KNOWN_TOKEN), fakeContext());

    const rows = await sql<
      {
        message_id: string;
        ip: string | null;
        user_agent: string | null;
        geo: unknown;
        proxy_label: string | null;
        tag: string;
        hit_at: Date;
        notify_after: Date | null;
        notified_at: Date | null;
      }[]
    >`
      SELECT message_id, host(ip) AS ip, user_agent, geo, proxy_label, tag,
             hit_at, notify_after, notified_at
      FROM public.pixel_hits WHERE message_id = ${knownMessageId}
    `;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.message_id).toBe(knownMessageId);
    expect(row.ip).toBe('8.8.8.8');
    expect(row.user_agent).toMatch(/Chrome/);
    expect(row.geo).toMatchObject({ city: 'Mountain View' });
    expect(row.proxy_label).toBeNull();
    expect(row.tag).toBe('none');
    expect(row.notified_at).toBeNull();
    const delta = row.notify_after!.getTime() - row.hit_at.getTime();
    expect(delta).toBeGreaterThanOrEqual(89_000);
    expect(delta).toBeLessThanOrEqual(91_000);
    expect(row.hit_at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('treats a Google-CIDR IP as proxy_label="google" and still tags "none"', async () => {
    await pixelHandler(
      pixelRequest(KNOWN_TOKEN),
      fakeContext({ ip: '66.249.84.42' }),
    );
    const rows = await sql<{ proxy_label: string | null; tag: string }[]>`
      SELECT proxy_label, tag FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.proxy_label).toBe('google');
    expect(rows[0]!.tag).toBe('none');
  });

  it('treats an Apple MPP UA as proxy_label="apple_mpp" and tag stays "none" with notify_after set', async () => {
    await pixelHandler(
      pixelRequest(KNOWN_TOKEN, {
        'user-agent': 'Mozilla/5.0 ApplePushService/2.0 (iPhone)',
      }),
      fakeContext(),
    );
    const rows = await sql<
      { proxy_label: string | null; tag: string; notify_after: Date | null }[]
    >`
      SELECT proxy_label, tag, notify_after FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.proxy_label).toBe('apple_mpp');
    expect(rows[0]!.tag).toBe('none');
    expect(rows[0]!.notify_after).not.toBeNull();
  });

  it('tags an early hit as likely_prefetch with notify_after = null', async () => {
    // A small backdate keeps the test robust against host/Docker clock
    // skew while staying inside the 10s prefetch window.
    await sql`UPDATE public.messages SET sent_at = now() - interval '1 second' WHERE id = ${knownMessageId}`;
    await pixelHandler(pixelRequest(KNOWN_TOKEN), fakeContext());
    const rows = await sql<{ tag: string; notify_after: Date | null }[]>`
      SELECT tag, notify_after FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.tag).toBe('likely_prefetch');
    expect(rows[0]!.notify_after).toBeNull();
  });

  it('tags a hit-after-beacon as self_view_desktop with notify_after = null', async () => {
    await sql`
      INSERT INTO public.self_view_beacons (user_id, gmail_thread_id, received_at)
      VALUES (${SEED_USER_ID}, ${KNOWN_THREAD}, now() - interval '1 second')
    `;
    await pixelHandler(pixelRequest(KNOWN_TOKEN), fakeContext());
    const rows = await sql<{ tag: string; notify_after: Date | null }[]>`
      SELECT tag, notify_after FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.tag).toBe('self_view_desktop');
    expect(rows[0]!.notify_after).toBeNull();
  });

  it('handles missing UA without crashing and stores empty string', async () => {
    const req = new Request(`https://example.test/pixel/${KNOWN_TOKEN}`, {
      method: 'GET',
    });
    const res = await pixelHandler(req, fakeContext());
    expect(res.status).toBe(200);
    const rows = await sql<{ user_agent: string | null }[]>`
      SELECT user_agent FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.user_agent).toBe('');
  });

  it('handles missing geo without crashing', async () => {
    const ctx = fakeContext({
      geo: undefined as unknown as Context['geo'],
      ip: undefined as unknown as Context['ip'],
    });
    const res = await pixelHandler(pixelRequest(KNOWN_TOKEN), ctx);
    expect(res.status).toBe(200);
    const rows = await sql<{ geo: unknown; ip: string | null }[]>`
      SELECT geo, host(ip) AS ip FROM public.pixel_hits
      WHERE message_id = ${knownMessageId}
    `;
    expect(rows[0]!.geo).toBeNull();
    expect(rows[0]!.ip).toBeNull();
  });
});

describe('pixel handler: error path', () => {
  it('returns 200 + GIF and logs structured error when the supabase client throws', async () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };
    const origUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = '';
    const factory = await import('../lib/supabase.js');
    factory._resetServiceRoleClientForTests();
    try {
      const res = await pixelHandler(pixelRequest(KNOWN_TOKEN), fakeContext());
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length).toBe(43);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toMatch(/"source":"pixel"/);
      expect(errors[0]).toMatch(/"stage":"unhandled"/);
    } finally {
      console.error = origError;
      process.env.SUPABASE_URL = origUrl;
      factory._resetServiceRoleClientForTests();
    }
  });
});
