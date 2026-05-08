import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetVapidConfiguredForTests,
  sendNotification,
  type PushSub,
  type PushPayload,
} from '../lib/push.js';

const mocks = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  setVapidDetailsMock: vi.fn(),
  supabaseFromMock: vi.fn(),
  supabaseDeleteEqMock: vi.fn(),
}));

// `web-push` is a singleton — `setVapidDetails` mutates module-level
// state — so we mock the whole module and inspect the mock directly.
vi.mock('web-push', () => ({
  default: {
    sendNotification: mocks.sendNotificationMock,
    setVapidDetails: mocks.setVapidDetailsMock,
  },
  sendNotification: mocks.sendNotificationMock,
  setVapidDetails: mocks.setVapidDetailsMock,
}));

vi.mock('../lib/supabase.js', () => ({
  serviceRoleClient: () => ({ from: mocks.supabaseFromMock }),
  authClient: () => ({}),
  _resetServiceRoleClientForTests: () => {},
}));

const { sendNotificationMock, setVapidDetailsMock, supabaseFromMock, supabaseDeleteEqMock } =
  mocks;

supabaseFromMock.mockImplementation(() => ({
  delete: () => ({
    eq: (_col: string, _val: string) => supabaseDeleteEqMock(),
  }),
}));

const SUB: PushSub = {
  id: 'sub-id-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: 'p256dh-value',
  auth: 'auth-value',
};

const PAYLOAD: PushPayload = {
  title: 'subject',
  body: 'recipient — Opened just now',
  icon: '/icon-192.png',
  data: { messageId: 'msg-1', dashboardUrl: '/messages/msg-1' },
};

beforeEach(() => {
  process.env.VAPID_PUBLIC_KEY = 'BNJ-test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
  process.env.VAPID_CONTACT = 'mailto:test@example.com';
  _resetVapidConfiguredForTests();
  sendNotificationMock.mockReset();
  setVapidDetailsMock.mockReset();
  supabaseFromMock.mockClear();
  supabaseFromMock.mockImplementation(() => ({
    delete: () => ({
      eq: (_col: string, _val: string) => supabaseDeleteEqMock(),
    }),
  }));
  supabaseDeleteEqMock.mockReset();
  supabaseDeleteEqMock.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('push.sendNotification', () => {
  it('configures VAPID once and sends the payload as JSON', async () => {
    sendNotificationMock.mockResolvedValueOnce({ statusCode: 201 });

    const result = await sendNotification(SUB, PAYLOAD);

    expect(setVapidDetailsMock).toHaveBeenCalledTimes(1);
    expect(setVapidDetailsMock).toHaveBeenCalledWith(
      'mailto:test@example.com',
      'BNJ-test-public-key',
      'test-private-key',
    );
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const args = sendNotificationMock.mock.calls[0]!;
    expect(args[0]).toEqual({
      endpoint: SUB.endpoint,
      keys: { p256dh: SUB.p256dh, auth: SUB.auth },
    });
    expect(JSON.parse(args[1] as string)).toEqual(PAYLOAD);
    expect(result).toEqual({ ok: true, transient: false, statusCode: 201 });
  });

  it('does not call setVapidDetails twice across calls', async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await sendNotification(SUB, PAYLOAD);
    await sendNotification(SUB, PAYLOAD);
    expect(setVapidDetailsMock).toHaveBeenCalledTimes(1);
  });

  it('throws if VAPID env is incomplete', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    _resetVapidConfiguredForTests();
    await expect(sendNotification(SUB, PAYLOAD)).rejects.toThrow(/VAPID env/);
  });

  it('on 410 Gone, deletes the subscription and returns ok=false transient=false', async () => {
    sendNotificationMock.mockRejectedValueOnce({
      statusCode: 410,
      message: 'Gone',
    });

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, transient: false, statusCode: 410 });
    expect(supabaseFromMock).toHaveBeenCalledWith('push_subscriptions');
    expect(supabaseDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('on 404 Not Found, deletes the subscription', async () => {
    sendNotificationMock.mockRejectedValueOnce({
      statusCode: 404,
      message: 'Not Found',
    });

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, transient: false, statusCode: 404 });
    expect(supabaseDeleteEqMock).toHaveBeenCalledTimes(1);
  });

  it('logs but does not throw if the subscription delete fails', async () => {
    sendNotificationMock.mockRejectedValueOnce({
      statusCode: 410,
      message: 'Gone',
    });
    supabaseDeleteEqMock.mockResolvedValue({ error: { message: 'db down' } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.transient).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('on a non-404/410 4xx, returns transient=false without deleting', async () => {
    sendNotificationMock.mockRejectedValueOnce({
      statusCode: 413,
      message: 'Payload Too Large',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, transient: false, statusCode: 413 });
    expect(supabaseDeleteEqMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('on a 5xx, returns transient=true', async () => {
    sendNotificationMock.mockRejectedValueOnce({
      statusCode: 503,
      message: 'Service Unavailable',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result).toEqual({ ok: false, transient: true, statusCode: 503 });
    expect(supabaseDeleteEqMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('on a network error (no statusCode), returns transient=true', async () => {
    sendNotificationMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendNotification(SUB, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.statusCode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
