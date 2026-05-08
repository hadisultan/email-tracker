import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// We test the service worker by loading dashboard/public/sw.js into a
// fresh ServiceWorkerGlobalScope-shaped object using service-worker-mock,
// then dispatching events and asserting on the side effects we care about.

interface MockClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
}

interface SwGlobals {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  registration: { showNotification: ReturnType<typeof vi.fn> };
  clients: {
    matchAll: ReturnType<typeof vi.fn>;
    openWindow: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
  };
  skipWaiting: ReturnType<typeof vi.fn>;
  trigger(type: string, event: unknown): Promise<unknown>;
}

let sw: SwGlobals;
let listeners: Map<string, Array<(event: unknown) => void>>;
let mockClients: MockClient[];

beforeEach(async () => {
  // Build a tiny mock SW global. We deliberately don't use the
  // service-worker-mock library directly because the project already
  // brings in vitest+vi mocks, and the SW we're testing only touches
  // four globals: self.addEventListener, self.registration.show*,
  // self.clients.*, and self.skipWaiting.
  listeners = new Map();
  mockClients = [];
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockImplementation(async () => mockClients);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const claim = vi.fn().mockResolvedValue(undefined);
  const skipWaiting = vi.fn().mockResolvedValue(undefined);

  sw = {
    addEventListener: (type, listener) => {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    registration: { showNotification },
    clients: { matchAll, openWindow, claim },
    skipWaiting,
    async trigger(type, event) {
      const arr = listeners.get(type) ?? [];
      for (const fn of arr) {
        const result = fn(event);
        if (result instanceof Promise) await result;
      }
      // Return the last waitUntil promise so tests can await side effects.
      return undefined;
    },
  };

  const swPath = resolve(__dirname, '..', 'public', 'sw.js');
  const source = readFileSync(swPath, 'utf-8');
  // Execute the SW source with `self` bound to our mock.
  const fn = new Function('self', source);
  fn(sw);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeNotificationEvent(data: unknown) {
  const close = vi.fn();
  const promises: Promise<unknown>[] = [];
  return {
    notification: { close, data },
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    _flush: () => Promise.all(promises),
    _close: close,
  };
}

function makePushEvent(payload: unknown) {
  const promises: Promise<unknown>[] = [];
  return {
    data: {
      json: () => payload,
      text: () => JSON.stringify(payload),
    },
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    _flush: () => Promise.all(promises),
  };
}

describe('service worker', () => {
  it('registers install + activate + push + notificationclick listeners', () => {
    expect(listeners.has('install')).toBe(true);
    expect(listeners.has('activate')).toBe(true);
    expect(listeners.has('push')).toBe(true);
    expect(listeners.has('notificationclick')).toBe(true);
  });

  it('shows a notification with the title and body from the push payload', async () => {
    const event = makePushEvent({
      title: 'Alice opened your email',
      body: 'Sent 2 minutes ago',
      data: { messageId: 'm-123', dashboardUrl: '/messages/m-123' },
    });
    await sw.trigger('push', event);
    await event._flush();
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      'Alice opened your email',
      expect.objectContaining({
        body: 'Sent 2 minutes ago',
        data: { messageId: 'm-123', dashboardUrl: '/messages/m-123' },
        tag: 'msg:m-123',
      }),
    );
  });

  it('falls back to defaults when the push event has no data', async () => {
    const event = { waitUntil: () => undefined } as unknown;
    await sw.trigger('push', event);
    expect(sw.registration.showNotification).toHaveBeenCalledWith(
      'Email tracker',
      expect.objectContaining({ body: 'A tracked email was just opened.' }),
    );
  });

  it('opens a new window when notificationclick fires and no client matches', async () => {
    mockClients = [];
    const event = makeNotificationEvent({
      messageId: 'm-1',
      dashboardUrl: '/messages/m-1',
    });
    await sw.trigger('notificationclick', event);
    await event._flush();
    expect(event._close).toHaveBeenCalled();
    expect(sw.clients.openWindow).toHaveBeenCalledWith('/messages/m-1');
  });

  it('focuses an existing client whose URL ends in dashboardUrl rather than opening a new window', async () => {
    const focus = vi.fn();
    mockClients = [{ url: 'https://app/messages/m-1', focus }];
    const event = makeNotificationEvent({
      messageId: 'm-1',
      dashboardUrl: '/messages/m-1',
    });
    await sw.trigger('notificationclick', event);
    await event._flush();
    expect(focus).toHaveBeenCalledOnce();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });

  it('falls back to "/" when notification data is missing dashboardUrl', async () => {
    mockClients = [];
    const event = makeNotificationEvent(null);
    await sw.trigger('notificationclick', event);
    await event._flush();
    expect(sw.clients.openWindow).toHaveBeenCalledWith('/');
  });
});
