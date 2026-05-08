import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';
import { computePollSignature } from '../lib/auth.js';
import { _resetPgClientForTests } from '../lib/db.js';

// Env wiring — must be set before importing the handler. The OAuth
// client id/secret are only used when the handler decides to refresh
// the access token; tests that exercise the refresh path supply the
// env via the same names. POLL_HMAC_SECRET drives the X-Signature.
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;
process.env.POLL_HMAC_SECRET ??= 'test-poll-secret';
process.env.GMAIL_OAUTH_CLIENT_ID ??= 'test-client-id.apps.googleusercontent.com';
process.env.GMAIL_OAUTH_CLIENT_SECRET ??= 'test-client-secret';

const { default: gmailPoll } = await import('../gmail-poll.js');

let sql: Sql;
const ctx = {} as never;

beforeAll(() => {
  sql = postgres(LOCAL_DB_URL, { onnotice: () => {}, max: 4 });
});

afterAll(async () => {
  _resetPgClientForTests();
  await sql.end({ timeout: 1 });
});

beforeEach(async () => {
  // Clean slate for each test.
  await sql`DELETE FROM public.pixel_hits WHERE message_id IN (SELECT id FROM public.messages WHERE user_id = ${SEED_USER_ID})`;
  await sql`DELETE FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.gmail_poll_runs`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function postPoll(body = ''): Request {
  const sig = computePollSignature(body);
  return new Request('http://localhost/api/gmail-poll', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': sig,
    },
    body: body || undefined,
  });
}

interface GmailFetchScript {
  profile?: { historyId: string; emailAddress?: string };
  // Sequence of history.list responses (one per call).
  historyPages?: Array<{
    history?: unknown[];
    historyId: string;
    nextPageToken?: string;
  }>;
  historyError?: { status: number; body?: unknown };
  oauthRefresh?:
    | { ok: true; access_token: string; expires_in: number }
    | { ok: false; status: number; body?: unknown };
}

function installFetchMock(script: GmailFetchScript): ReturnType<typeof vi.spyOn> {
  let historyIdx = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === 'https://oauth2.googleapis.com/token') {
      if (!script.oauthRefresh) {
        return new Response(
          JSON.stringify({ access_token: 'ya29.refreshed', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (script.oauthRefresh.ok) {
        return new Response(
          JSON.stringify({
            access_token: script.oauthRefresh.access_token,
            expires_in: script.oauthRefresh.expires_in,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(script.oauthRefresh.body ?? {}), {
        status: script.oauthRefresh.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) {
      if (!script.profile) {
        return new Response('no profile script', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          historyId: script.profile.historyId,
          emailAddress: script.profile.emailAddress ?? 'me@example.com',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/history')) {
      if (script.historyError) {
        return new Response(JSON.stringify(script.historyError.body ?? {}), {
          status: script.historyError.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const page = script.historyPages?.[historyIdx];
      historyIdx++;
      if (!page) {
        return new Response('no history page scripted', { status: 500 });
      }
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unscripted fetch: ${url}`);
  });
  return spy as never;
}

async function seedCreds(args: {
  refreshToken?: string | null;
  accessToken?: string | null;
  accessExpiresAtIso?: string | null;
  lastHistoryId?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email)
    VALUES (${SEED_USER_ID}, 'seed@example.com')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.gmail_credentials
      (user_id, refresh_token, access_token, access_token_expires_at, last_history_id)
    VALUES (
      ${SEED_USER_ID},
      ${args.refreshToken ?? null},
      ${args.accessToken ?? null},
      ${args.accessExpiresAtIso ?? null},
      ${args.lastHistoryId ?? null}
    )
  `;
}

async function seedMessage(threadId: string, sentAtIso: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.messages
      (user_id, token, client_send_id, subject, recipients, gmail_thread_id, sent_at)
    VALUES (
      ${SEED_USER_ID},
      ${'tok-' + Math.random().toString(36).slice(2)},
      gen_random_uuid(),
      ${'subject-' + threadId},
      ARRAY['recipient@example.com'],
      ${threadId},
      ${sentAtIso}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function seedPixelHit(args: {
  messageId: string;
  hitAtIso: string;
  tag?: 'none' | 'self_view_mobile' | 'self_view_desktop' | 'likely_prefetch';
  notifyAfterIso?: string | null;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.pixel_hits (message_id, hit_at, tag, notify_after)
    VALUES (
      ${args.messageId},
      ${args.hitAtIso},
      ${args.tag ?? 'none'},
      ${args.notifyAfterIso ?? null}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function pixelHitTag(id: string): Promise<string> {
  const rows = await sql<{ tag: string }[]>`
    SELECT tag FROM public.pixel_hits WHERE id = ${id}
  `;
  return rows[0]!.tag;
}

async function lastPollRun(): Promise<{
  ok: boolean | null;
  error: string | null;
  history_ids_processed: number | null;
  drained_pushes: number | null;
} | null> {
  const rows = await sql<
    {
      ok: boolean | null;
      error: string | null;
      history_ids_processed: number | null;
      drained_pushes: number | null;
    }[]
  >`
    SELECT ok, error, history_ids_processed, drained_pushes
    FROM public.gmail_poll_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? rows[0]! : null;
}

async function readCursor(): Promise<string | null> {
  const rows = await sql<{ last_history_id: string | null }[]>`
    SELECT last_history_id FROM public.gmail_credentials WHERE user_id = ${SEED_USER_ID}
  `;
  return rows[0]?.last_history_id ?? null;
}

describe('gmail-poll handler — auth and lifecycle', () => {
  it('returns 401 when X-Signature header is missing', async () => {
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const res = await gmailPoll(req, ctx);
    expect(res.status).toBe(401);
    expect(await lastPollRun()).toBeNull();
  });

  it('returns 401 when X-Signature does not match', async () => {
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' },
    });
    const res = await gmailPoll(req, ctx);
    expect(res.status).toBe(401);
    expect(await lastPollRun()).toBeNull();
  });

  it('returns ok=false {no_credentials} when no gmail_credentials row exists', async () => {
    installFetchMock({});
    const res = await gmailPoll(postPoll(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('no_credentials');
    const run = await lastPollRun();
    expect(run?.ok).toBe(false);
    expect(run?.error).toBe('no_credentials');
  });

  it('returns ok=false {oauth_revoked} when refresh_token is null', async () => {
    await seedCreds({ refreshToken: null, lastHistoryId: '1000' });
    installFetchMock({});
    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('oauth_revoked');
    expect((await lastPollRun())?.error).toBe('oauth_revoked');
  });
});

describe('gmail-poll handler — first run', () => {
  it('baselines last_history_id from getProfile and exits without classifying', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: null,
    });
    installFetchMock({ profile: { historyId: '5000' } });

    const res = await gmailPoll(postPoll(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; baselined: boolean; history_id: string };
    expect(body).toMatchObject({ ok: true, baselined: true, history_id: '5000' });

    expect(await readCursor()).toBe('5000');
    const run = await lastPollRun();
    expect(run?.ok).toBe(true);
    expect(run?.history_ids_processed).toBe(0);
    expect(run?.drained_pushes).toBe(0);
  });
});

describe('gmail-poll handler — steady state classification', () => {
  it('tags pixel_hits as self_view_mobile when UNREAD is removed for a tracked thread within the 1h window', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });
    const messageId = await seedMessage('thread-T1', new Date(Date.now() - 30 * 60_000).toISOString());
    const hitId = await seedPixelHit({
      messageId,
      hitAtIso: new Date(Date.now() - 25 * 60_000).toISOString(),
      tag: 'none',
      notifyAfterIso: new Date(Date.now() + 60_000).toISOString(),
    });

    installFetchMock({
      historyPages: [
        {
          history: [
            {
              id: '1100',
              labelsRemoved: [
                {
                  message: { id: 'gm-1', threadId: 'thread-T1' },
                  labelIds: ['UNREAD'],
                },
              ],
            },
          ],
          historyId: '1100',
        },
      ],
    });

    const res = await gmailPoll(postPoll(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      hits_updated: number;
      threads_classified: number;
      new_history_id: string;
    };
    expect(body.ok).toBe(true);
    expect(body.hits_updated).toBe(1);
    expect(body.threads_classified).toBe(1);
    expect(body.new_history_id).toBe('1100');

    expect(await pixelHitTag(hitId)).toBe('self_view_mobile');
    // notify_after should be cleared.
    const rows = await sql<{ notify_after: string | null }[]>`
      SELECT notify_after FROM public.pixel_hits WHERE id = ${hitId}
    `;
    expect(rows[0]!.notify_after).toBeNull();

    expect(await readCursor()).toBe('1100');
  });

  it('does NOT tag pixel_hits older than 1 hour', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });
    const messageId = await seedMessage('thread-T1', new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    const hitId = await seedPixelHit({
      messageId,
      hitAtIso: new Date(Date.now() - 90 * 60_000).toISOString(),
      tag: 'none',
    });

    installFetchMock({
      historyPages: [
        {
          history: [
            {
              id: '1100',
              labelsRemoved: [
                { message: { id: 'gm', threadId: 'thread-T1' }, labelIds: ['UNREAD'] },
              ],
            },
          ],
          historyId: '1100',
        },
      ],
    });

    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; hits_updated: number };
    expect(body.ok).toBe(true);
    expect(body.hits_updated).toBe(0);
    expect(await pixelHitTag(hitId)).toBe('none');
  });

  it('ignores labelRemoved events whose labelIds do NOT include UNREAD', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });
    const messageId = await seedMessage('thread-T1', new Date(Date.now() - 10 * 60_000).toISOString());
    const hitId = await seedPixelHit({
      messageId,
      hitAtIso: new Date(Date.now() - 5 * 60_000).toISOString(),
      tag: 'none',
    });

    installFetchMock({
      historyPages: [
        {
          history: [
            {
              id: '1100',
              labelsRemoved: [
                {
                  message: { id: 'gm', threadId: 'thread-T1' },
                  labelIds: ['CATEGORY_PROMOTIONS'],
                },
              ],
            },
          ],
          historyId: '1100',
        },
      ],
    });

    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; hits_updated: number; threads_classified: number };
    expect(body.ok).toBe(true);
    expect(body.threads_classified).toBe(0);
    expect(body.hits_updated).toBe(0);
    expect(await pixelHitTag(hitId)).toBe('none');
  });

  it('handles a foreign thread (no matching message) without errors', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });

    installFetchMock({
      historyPages: [
        {
          history: [
            {
              id: '1100',
              labelsRemoved: [
                { message: { id: 'gm', threadId: 'thread-FOREIGN' }, labelIds: ['UNREAD'] },
              ],
            },
          ],
          historyId: '1100',
        },
      ],
    });

    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; hits_updated: number };
    expect(body.ok).toBe(true);
    expect(body.hits_updated).toBe(0);
    expect(await readCursor()).toBe('1100');
  });

  it('paginates through multiple history pages and advances cursor to the final historyId', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });
    const messageId = await seedMessage('thread-T1', new Date(Date.now() - 10 * 60_000).toISOString());
    await seedPixelHit({ messageId, hitAtIso: new Date(Date.now() - 5 * 60_000).toISOString(), tag: 'none' });

    installFetchMock({
      historyPages: [
        {
          history: [
            {
              id: '1100',
              labelsRemoved: [
                { message: { id: 'm1', threadId: 'thread-T1' }, labelIds: ['UNREAD'] },
              ],
            },
          ],
          historyId: '1100',
          nextPageToken: 'PT_NEXT',
        },
        {
          history: [
            {
              id: '1200',
              labelsRemoved: [
                { message: { id: 'm2', threadId: 'thread-T1' }, labelIds: ['UNREAD'] },
              ],
            },
          ],
          historyId: '1200',
        },
      ],
    });

    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; history_records: number; new_history_id: string };
    expect(body.ok).toBe(true);
    expect(body.history_records).toBe(2);
    expect(body.new_history_id).toBe('1200');
    expect(await readCursor()).toBe('1200');
  });
});

describe('gmail-poll handler — error recovery', () => {
  it('rebaselines the cursor when Gmail returns 404 for a stale historyId', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });

    installFetchMock({
      historyError: { status: 404, body: { error: { code: 404, message: 'not found' } } },
      profile: { historyId: '9999' },
    });

    const res = await gmailPoll(postPoll(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rebaselined: boolean; history_id: string };
    expect(body).toMatchObject({ ok: true, rebaselined: true, history_id: '9999' });
    expect(await readCursor()).toBe('9999');
    const run = await lastPollRun();
    expect(run?.ok).toBe(true);
    expect(run?.error).toBe('rebaselined_after_404');
  });

  it('records ok=false {oauth_revoked} when refresh exchange fails', async () => {
    await seedCreds({
      refreshToken: 'rt_revoked',
      accessToken: null,
      accessExpiresAtIso: null,
      lastHistoryId: '1000',
    });
    installFetchMock({
      oauthRefresh: { ok: false, status: 400, body: { error: 'invalid_grant' } },
    });
    const res = await gmailPoll(postPoll(), ctx);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('oauth_revoked');
    const run = await lastPollRun();
    expect(run?.ok).toBe(false);
    expect(run?.error).toContain('oauth_revoked');
  });
});

describe('gmail-poll handler — concurrency lock', () => {
  it('returns {skipped: true, reason: lock} and records no run when another transaction holds the advisory lock', async () => {
    await seedCreds({
      refreshToken: 'rt_test',
      accessToken: 'ya29.fresh',
      accessExpiresAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastHistoryId: '1000',
    });

    // Hold the advisory lock in a separate transaction. The poller's
    // `pg_try_advisory_xact_lock` should return false.
    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const POLLER_LOCK_KEY = 0x6574_706c;
    const lockPromise = sql.begin(async (tx) => {
      await tx<{ ok: boolean }[]>`
        SELECT pg_advisory_xact_lock(${POLLER_LOCK_KEY}) AS ok
      `;
      // Hold the lock until the test releases it.
      await holderDone;
    });

    // Give the holder a moment to acquire the lock.
    await new Promise((r) => setTimeout(r, 100));

    installFetchMock({});
    const res = await gmailPoll(postPoll(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: boolean; reason: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('lock');

    // No run row recorded for a lock-skip.
    expect(await lastPollRun()).toBeNull();

    releaseHolder!();
    await lockPromise;
  });
});
