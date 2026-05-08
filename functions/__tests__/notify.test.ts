import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';

// Mock the web-push wrapper. `notify.ts` calls `sendNotification` from
// `./push.js`; we control its behavior per-test. The real DB is used
// for everything else (atomic CAS UPDATE on messages.last_notified_at,
// pixel_hits.notified_at stamping, push_subscriptions.last_success_at).
const mocks = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));
vi.mock('../lib/push.js', () => ({
  sendNotification: mocks.sendNotificationMock,
  _resetVapidConfiguredForTests: () => {},
}));
const { sendNotificationMock } = mocks;

const { sendPushesForHit } = await import('../lib/notify.js');

let sql: Sql;

beforeAll(() => {
  sql = postgres(LOCAL_DB_URL, { onnotice: () => {}, max: 4 });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

beforeEach(async () => {
  sendNotificationMock.mockReset();
  await sql`DELETE FROM public.pixel_hits WHERE message_id IN (SELECT id FROM public.messages WHERE user_id = ${SEED_USER_ID})`;
  await sql`DELETE FROM public.push_subscriptions WHERE user_id = ${SEED_USER_ID}`;
  await sql`DELETE FROM public.messages WHERE user_id = ${SEED_USER_ID}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedMessage(args: {
  subject: string | null;
  recipients: string[];
  threadId?: string;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.messages
      (user_id, token, client_send_id, subject, recipients, gmail_thread_id, sent_at)
    VALUES (
      ${SEED_USER_ID},
      ${'tok-' + Math.random().toString(36).slice(2)},
      gen_random_uuid(),
      ${args.subject},
      ${args.recipients},
      ${args.threadId ?? null},
      now()
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function seedHit(messageId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.pixel_hits (message_id, hit_at, tag, notify_after)
    VALUES (${messageId}, now() - interval '2 minutes', 'none', now() - interval '60 seconds')
    RETURNING id
  `;
  return rows[0]!.id;
}

async function seedSub(label: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (
      ${SEED_USER_ID},
      ${'https://fcm.googleapis.com/fcm/send/' + label},
      ${'p256dh-' + label},
      ${'auth-' + label}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function readHit(id: string): Promise<{ notified_at: Date | null }> {
  const rows = await sql<{ notified_at: Date | null }[]>`
    SELECT notified_at FROM public.pixel_hits WHERE id = ${id}
  `;
  return rows[0]!;
}

async function readMessage(id: string): Promise<{ last_notified_at: Date | null }> {
  const rows = await sql<{ last_notified_at: Date | null }[]>`
    SELECT last_notified_at FROM public.messages WHERE id = ${id}
  `;
  return rows[0]!;
}

async function readSub(id: string): Promise<{ last_success_at: Date | null } | null> {
  const rows = await sql<{ last_success_at: Date | null }[]>`
    SELECT last_success_at FROM public.push_subscriptions WHERE id = ${id}
  `;
  return rows.length > 0 ? rows[0]! : null;
}

describe('sendPushesForHit — happy path', () => {
  it('sends one push, stamps notified_at, updates last_success_at, returns pushes_sent=1', async () => {
    const msgId = await seedMessage({
      subject: 'Quarterly review',
      recipients: ['boss@example.com'],
    });
    const hitId = await seedHit(msgId);
    const subId = await seedSub('alpha');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    const result = await sendPushesForHit(sql, hitId);

    expect(result).toEqual({ pushes_sent: 1, deduped: false, subscription_count: 1 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const args = sendNotificationMock.mock.calls[0]!;
    expect(args[0]).toMatchObject({
      endpoint: 'https://fcm.googleapis.com/fcm/send/alpha',
      p256dh: 'p256dh-alpha',
      auth: 'auth-alpha',
    });
    expect(args[1]).toEqual({
      title: 'Quarterly review',
      body: 'boss@example.com — Opened just now',
      icon: '/icon-192.png',
      data: { messageId: msgId, dashboardUrl: `/messages/${msgId}` },
    });
    expect((await readHit(hitId)).notified_at).not.toBeNull();
    expect((await readMessage(msgId)).last_notified_at).not.toBeNull();
    expect((await readSub(subId))!.last_success_at).not.toBeNull();
  });

  it('uses "(no subject)" when subject is null', async () => {
    const msgId = await seedMessage({ subject: null, recipients: ['x@example.com'] });
    const hitId = await seedHit(msgId);
    await seedSub('null-subj');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    await sendPushesForHit(sql, hitId);

    const payload = sendNotificationMock.mock.calls[0]![1] as { title: string };
    expect(payload.title).toBe('(no subject)');
  });

  it('uses "(no subject)" when subject is empty string', async () => {
    const msgId = await seedMessage({ subject: '', recipients: ['x@example.com'] });
    const hitId = await seedHit(msgId);
    await seedSub('empty-subj');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    await sendPushesForHit(sql, hitId);

    const payload = sendNotificationMock.mock.calls[0]![1] as { title: string };
    expect(payload.title).toBe('(no subject)');
  });

  it('renders multi-recipient label as "<n> recipients"', async () => {
    const msgId = await seedMessage({
      subject: 'broadcast',
      recipients: ['a@x.com', 'b@x.com', 'c@x.com'],
    });
    const hitId = await seedHit(msgId);
    await seedSub('multi');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    await sendPushesForHit(sql, hitId);

    const payload = sendNotificationMock.mock.calls[0]![1] as { body: string };
    expect(payload.body).toBe('3 recipients — Opened just now');
  });

  it('preserves emoji/Unicode in subject', async () => {
    const subject = 'Status 🚀 — naïve résumé';
    const msgId = await seedMessage({ subject, recipients: ['x@example.com'] });
    const hitId = await seedHit(msgId);
    await seedSub('emoji');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    await sendPushesForHit(sql, hitId);

    const payload = sendNotificationMock.mock.calls[0]![1] as { title: string };
    expect(payload.title).toBe(subject);
  });
});

describe('sendPushesForHit — dedupe', () => {
  it('second call within the same hour short-circuits, sends nothing, but stamps the second hit', async () => {
    const msgId = await seedMessage({
      subject: 'msg',
      recipients: ['x@example.com'],
    });
    const hitA = await seedHit(msgId);
    const hitB = await seedHit(msgId);
    await seedSub('dedupe');
    sendNotificationMock.mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 });

    const a = await sendPushesForHit(sql, hitA);
    const b = await sendPushesForHit(sql, hitB);

    expect(a).toEqual({ pushes_sent: 1, deduped: false, subscription_count: 1 });
    expect(b).toEqual({ pushes_sent: 0, deduped: true, subscription_count: 0 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect((await readHit(hitA)).notified_at).not.toBeNull();
    expect((await readHit(hitB)).notified_at).not.toBeNull();
  });
});

describe('sendPushesForHit — edge cases', () => {
  it('returns pushes_sent=0 with zero subs but still stamps notified_at', async () => {
    const msgId = await seedMessage({
      subject: 'orphan',
      recipients: ['x@example.com'],
    });
    const hitId = await seedHit(msgId);

    const result = await sendPushesForHit(sql, hitId);

    expect(result).toEqual({ pushes_sent: 0, deduped: false, subscription_count: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect((await readHit(hitId)).notified_at).not.toBeNull();
    expect((await readMessage(msgId)).last_notified_at).not.toBeNull();
  });

  it('returns 0 when hitId does not exist', async () => {
    const result = await sendPushesForHit(sql, '00000000-0000-0000-0000-000000000000');
    expect(result).toEqual({ pushes_sent: 0, deduped: false, subscription_count: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe('sendPushesForHit — error paths', () => {
  it('on a transient error and no successes, leaves notified_at NULL so next tick retries', async () => {
    const msgId = await seedMessage({
      subject: 'transient',
      recipients: ['x@example.com'],
    });
    const hitId = await seedHit(msgId);
    await seedSub('transient');
    sendNotificationMock.mockResolvedValueOnce({ ok: false, transient: true, statusCode: 503 });

    const result = await sendPushesForHit(sql, hitId);

    expect(result.pushes_sent).toBe(0);
    expect((await readHit(hitId)).notified_at).toBeNull();
    expect((await readMessage(msgId)).last_notified_at).not.toBeNull();
  });

  it('on a non-transient error (404/410) with all subs gone, stamps notified_at (no retry)', async () => {
    const msgId = await seedMessage({
      subject: 'gone',
      recipients: ['x@example.com'],
    });
    const hitId = await seedHit(msgId);
    await seedSub('gone');
    sendNotificationMock.mockResolvedValueOnce({ ok: false, transient: false, statusCode: 410 });

    const result = await sendPushesForHit(sql, hitId);

    expect(result.pushes_sent).toBe(0);
    expect((await readHit(hitId)).notified_at).not.toBeNull();
  });

  it('with one success and one transient, still stamps notified_at (success wins)', async () => {
    const msgId = await seedMessage({
      subject: 'mixed',
      recipients: ['x@example.com'],
    });
    const hitId = await seedHit(msgId);
    const okSub = await seedSub('good');
    await seedSub('transient2');

    // sendNotification is called per sub; we don't know order so handle
    // both results regardless of which sub each call gets.
    sendNotificationMock
      .mockResolvedValueOnce({ ok: true, transient: false, statusCode: 201 })
      .mockResolvedValueOnce({ ok: false, transient: true, statusCode: 503 });

    const result = await sendPushesForHit(sql, hitId);

    expect(result.pushes_sent).toBe(1);
    expect(result.subscription_count).toBe(2);
    expect((await readHit(hitId)).notified_at).not.toBeNull();
    expect((await readSub(okSub))!.last_success_at).not.toBeNull();
  });

  it('an unhandled throw from sendNotification is treated as transient', async () => {
    const msgId = await seedMessage({
      subject: 'thrown',
      recipients: ['x@example.com'],
    });
    const hitId = await seedHit(msgId);
    await seedSub('thrown');
    sendNotificationMock.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendPushesForHit(sql, hitId);

    expect(result.pushes_sent).toBe(0);
    expect((await readHit(hitId)).notified_at).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
