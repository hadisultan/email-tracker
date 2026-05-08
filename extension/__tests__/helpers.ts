// chrome.storage.local + fetch stubs for extension tests.
//
// The extension code calls chrome.storage.local.{get,set,remove} as a
// drop-in async API. JSDOM doesn't have it, so we install a tiny
// in-memory shim per test. fetch is also stubbed per test via
// vi.spyOn(globalThis, 'fetch').

import { vi } from 'vitest';

interface ChromeStorageLocal {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

export interface ChromeStub {
  storage: { local: ChromeStorageLocal };
  __backing: Record<string, unknown>;
}

export function installChromeStub(): ChromeStub {
  const backing: Record<string, unknown> = {};

  const local: ChromeStorageLocal = {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === undefined || keys === null) return { ...backing };
      if (typeof keys === 'string') {
        return keys in backing ? { [keys]: backing[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in backing) out[k] = backing[k];
        return out;
      }
      const out: Record<string, unknown> = { ...keys };
      for (const k of Object.keys(keys)) if (k in backing) out[k] = backing[k];
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(backing, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete backing[k];
    }),
    clear: vi.fn(async () => {
      for (const k of Object.keys(backing)) delete backing[k];
    }),
  };

  const stub: ChromeStub = {
    storage: { local },
    __backing: backing,
  };

  (globalThis as unknown as { chrome: typeof stub }).chrome = stub;
  return stub;
}

export function uninstallChromeStub(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}

export function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
