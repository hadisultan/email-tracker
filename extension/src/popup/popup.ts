// Popup controller. Reads paired state from chrome.storage.local on
// load, routes the pairing form submit through `pairClaim`, and surfaces
// pairing errors with friendly copy.
//
// Exported as an `init(doc)` factory for testability — JSDOM tests build
// the document themselves and pass it in.

import { ApiError, getStoredToken, pairClaim } from '../lib/api.js';

interface PopupRefs {
  status: HTMLElement;
  codeInput: HTMLInputElement;
  pairBtn: HTMLButtonElement;
  errEl: HTMLElement;
  form: HTMLFormElement;
}

function refsFrom(doc: Document): PopupRefs {
  const status = doc.getElementById('status');
  const codeInput = doc.getElementById('code');
  const pairBtn = doc.getElementById('pair-btn');
  const errEl = doc.getElementById('error');
  const form = doc.getElementById('pair-form');
  if (
    !(status instanceof HTMLElement) ||
    !(codeInput instanceof HTMLInputElement) ||
    !(pairBtn instanceof HTMLButtonElement) ||
    !(errEl instanceof HTMLElement) ||
    !(form instanceof HTMLFormElement)
  ) {
    throw new Error('popup: required elements missing from document');
  }
  return { status, codeInput, pairBtn, errEl, form };
}

function renderPaired(refs: PopupRefs, paired: boolean): void {
  if (paired) {
    refs.status.textContent = 'Paired \u2713';
    refs.status.className = 'status status-paired';
  } else {
    refs.status.textContent = 'Not paired';
    refs.status.className = 'status status-unpaired';
  }
}

function renderError(refs: PopupRefs, message: string | null): void {
  if (message) {
    refs.errEl.textContent = message;
    refs.errEl.removeAttribute('hidden');
  } else {
    refs.errEl.textContent = '';
    refs.errEl.setAttribute('hidden', '');
  }
}

function messageFor(code: string, fallback: string): string {
  switch (code) {
    case 'code_invalid':
      return 'Pairing code not recognized. Check for typos.';
    case 'code_expired':
      return 'Pairing code expired. Generate a new one in the dashboard.';
    case 'code_consumed':
      return 'Pairing code already used. Generate a new one in the dashboard.';
    case 'no_token':
      return 'Extension is not paired.';
    default:
      return fallback || 'Pairing failed. Try again.';
  }
}

export async function init(doc: Document = document): Promise<void> {
  const refs = refsFrom(doc);

  const existing = await getStoredToken();
  renderPaired(refs, existing !== null);

  refs.codeInput.addEventListener('input', () => {
    refs.pairBtn.disabled = refs.codeInput.value.trim().length === 0;
  });

  refs.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = refs.codeInput.value.trim();
    if (code.length === 0) return;

    refs.pairBtn.disabled = true;
    renderError(refs, null);
    try {
      await pairClaim(code);
      renderPaired(refs, true);
      refs.codeInput.value = '';
    } catch (err) {
      renderPaired(refs, false);
      if (err instanceof ApiError) {
        renderError(refs, messageFor(err.code, err.message));
      } else {
        renderError(refs, 'Network error. Check that the dashboard is reachable.');
      }
    } finally {
      refs.pairBtn.disabled = refs.codeInput.value.trim().length === 0;
    }
  });
}

// Auto-init only inside a real Chrome extension context. The check for
// `chrome.runtime?.id` distinguishes the production popup (where the
// runtime ID is the extension ID) from JSDOM-based tests (which install
// a chrome.storage stub but no chrome.runtime).
declare const chrome: { runtime?: { id?: string } } | undefined;
if (
  typeof document !== 'undefined' &&
  typeof chrome !== 'undefined' &&
  chrome?.runtime?.id
) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
  } else {
    void init();
  }
}
