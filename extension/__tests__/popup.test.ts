import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installChromeStub, uninstallChromeStub } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POPUP_HTML = readFileSync(
  resolve(HERE, '../src/popup/popup.html'),
  'utf8',
);

vi.mock('../src/lib/api.js', () => {
  class ApiError extends Error {
    override readonly name = 'ApiError';
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    getStoredToken: vi.fn(async () => null),
    pairClaim: vi.fn(),
  };
});

async function loadPopup() {
  return await import('../src/popup/popup.js');
}

function setBodyFromHtml(html: string): void {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  document.body.innerHTML = m ? m[1]! : html;
}

beforeEach(() => {
  vi.resetModules();
  installChromeStub();
  setBodyFromHtml(POPUP_HTML);
});

afterEach(() => {
  uninstallChromeStub();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('popup init', () => {
  it('renders "Not paired" when no token is stored', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
    };
    api.getStoredToken.mockResolvedValueOnce(null);

    const { init } = await loadPopup();
    await init(document);

    const status = document.getElementById('status') as HTMLElement;
    expect(status.textContent).toBe('Not paired');
    expect(status.classList.contains('status-unpaired')).toBe(true);
  });

  it('renders "Paired ✓" when a token is already stored', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
    };
    api.getStoredToken.mockResolvedValueOnce('et_existing');

    const { init } = await loadPopup();
    await init(document);

    const status = document.getElementById('status') as HTMLElement;
    expect(status.textContent).toContain('Paired');
    expect(status.classList.contains('status-paired')).toBe(true);
  });

  it('keeps the Pair button disabled until the input has text', async () => {
    const { init } = await loadPopup();
    await init(document);

    const input = document.getElementById('code') as HTMLInputElement;
    const btn = document.getElementById('pair-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    input.value = 'AAAA-BBBB-CCCC-DDDD';
    input.dispatchEvent(new Event('input'));
    expect(btn.disabled).toBe(false);

    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    expect(btn.disabled).toBe(true);
  });
});

describe('popup pairing flow', () => {
  it('on success: status flips to "Paired ✓", input clears, no error shown', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
      pairClaim: ReturnType<typeof vi.fn>;
    };
    api.getStoredToken.mockResolvedValueOnce(null);
    api.pairClaim.mockResolvedValueOnce({ token: 'et_new' });

    const { init } = await loadPopup();
    await init(document);

    const input = document.getElementById('code') as HTMLInputElement;
    const form = document.getElementById('pair-form') as HTMLFormElement;
    input.value = 'AAAA-BBBB-CCCC-DDDD';
    input.dispatchEvent(new Event('input'));

    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.pairClaim).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');

    const status = document.getElementById('status') as HTMLElement;
    expect(status.textContent).toContain('Paired');
    expect(status.classList.contains('status-paired')).toBe(true);

    expect(input.value).toBe('');
    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl.hasAttribute('hidden')).toBe(true);
  });

  it('on code_expired: status stays "Not paired", error message is shown', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
      pairClaim: ReturnType<typeof vi.fn>;
      ApiError: new (status: number, code: string, message: string) => Error;
    };
    api.getStoredToken.mockResolvedValueOnce(null);
    api.pairClaim.mockRejectedValueOnce(
      new api.ApiError(410, 'code_expired', 'pairing code expired'),
    );

    const { init } = await loadPopup();
    await init(document);

    const input = document.getElementById('code') as HTMLInputElement;
    const form = document.getElementById('pair-form') as HTMLFormElement;
    input.value = 'AAAA-BBBB-CCCC-DDDD';
    input.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const status = document.getElementById('status') as HTMLElement;
    expect(status.textContent).toBe('Not paired');
    expect(status.classList.contains('status-unpaired')).toBe(true);

    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl.hasAttribute('hidden')).toBe(false);
    expect(errEl.textContent).toMatch(/expired/i);
  });

  it('on code_consumed: error message points at the dashboard', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
      pairClaim: ReturnType<typeof vi.fn>;
      ApiError: new (status: number, code: string, message: string) => Error;
    };
    api.getStoredToken.mockResolvedValueOnce(null);
    api.pairClaim.mockRejectedValueOnce(
      new api.ApiError(410, 'code_consumed', 'already used'),
    );

    const { init } = await loadPopup();
    await init(document);

    const input = document.getElementById('code') as HTMLInputElement;
    const form = document.getElementById('pair-form') as HTMLFormElement;
    input.value = 'AAAA-BBBB-CCCC-DDDD';
    input.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl.hasAttribute('hidden')).toBe(false);
    expect(errEl.textContent).toMatch(/already used|new one/i);
  });

  it('on a non-ApiError throw (network failure): generic error message shown', async () => {
    const api = (await import('../src/lib/api.js')) as unknown as {
      getStoredToken: ReturnType<typeof vi.fn>;
      pairClaim: ReturnType<typeof vi.fn>;
    };
    api.getStoredToken.mockResolvedValueOnce(null);
    api.pairClaim.mockRejectedValueOnce(new TypeError('fetch failed'));

    const { init } = await loadPopup();
    await init(document);

    const input = document.getElementById('code') as HTMLInputElement;
    const form = document.getElementById('pair-form') as HTMLFormElement;
    input.value = 'AAAA-BBBB-CCCC-DDDD';
    input.dispatchEvent(new Event('input'));
    form.requestSubmit();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const errEl = document.getElementById('error') as HTMLElement;
    expect(errEl.hasAttribute('hidden')).toBe(false);
    expect(errEl.textContent).toMatch(/network/i);
  });
});
