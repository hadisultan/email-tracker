import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hookDialog, _internals } from '../src/content/gmail.js';
import type { MintFn } from '../src/content/compose-handler.js';

function makeComposeFixture(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `
    <input name="to" value="alice@example.com" />
    <input name="cc" value="" />
    <input name="bcc" value="" />
    <input name="subjectbox" value="hi" />
    <div role="textbox" aria-label="Message Body" contenteditable="true"><p>hello</p></div>
    <div role="button" data-tooltip="Send ‪(⌘Enter)‬">Send</div>
  `;
  return dialog;
}

function fakeMint(): MintFn {
  return vi.fn(async () => ({
    token: 'tk_test',
    pixel_url: 'http://localhost:8888/pixel/tk_test',
  })) as unknown as MintFn;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('hookDialog — idempotency', () => {
  it('returns true the first time and false on a second call with the same dialog', () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    expect(hookDialog(dialog, { mintFn: fakeMint() })).toBe(true);
    expect(hookDialog(dialog, { mintFn: fakeMint() })).toBe(false);
  });

  it('marks the dialog as hooked', () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    hookDialog(dialog, { mintFn: fakeMint() });
    expect(_internals.hookedDialogs.has(dialog)).toBe(true);
  });

  it('does not double-hook the Send button if the dialog is rebuilt with a new wrapper element', () => {
    // First mount.
    const dialog1 = makeComposeFixture();
    document.body.appendChild(dialog1);
    hookDialog(dialog1, { mintFn: fakeMint() });
    const send1 = dialog1.querySelector<HTMLElement>('div[role="button"]')!;
    expect(_internals.hookedSendButtons.has(send1)).toBe(true);

    // "Re-render": Gmail keeps the same Send button DOM node but wraps
    // it inside a new dialog wrapper. We construct a fresh dialog
    // wrapper element and move the same Send button into it.
    const dialog2 = document.createElement('div');
    dialog2.setAttribute('role', 'dialog');
    // Copy/move all children so the inner Send button reference is identical.
    while (dialog1.firstChild) dialog2.appendChild(dialog1.firstChild);
    document.body.replaceChild(dialog2, dialog1);

    // hookDialog should detect the same Send button and return false
    // (no new listener attached).
    const result = hookDialog(dialog2, { mintFn: fakeMint() });
    expect(result).toBe(false);
    expect(_internals.hookedDialogs.has(dialog2)).toBe(true);
  });
});

describe('hookDialog — send interception', () => {
  it('intercepts a click on the Send button and calls mintFn', async () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    const mintFn = fakeMint();
    hookDialog(dialog, { mintFn });

    const sendBtn = dialog.querySelector<HTMLElement>('div[role="button"]')!;
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // Allow the async trigger to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mintFn).toHaveBeenCalledTimes(1);
    const editor = dialog.querySelector<HTMLElement>('div[role="textbox"]')!;
    expect(editor.innerHTML).toContain('http://localhost:8888/pixel/tk_test');
  });

  it('Ctrl+Enter on the body editor follows the same code path as a click', async () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    const mintFn = fakeMint();
    hookDialog(dialog, { mintFn });

    const editor = dialog.querySelector<HTMLElement>('div[role="textbox"]')!;
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mintFn).toHaveBeenCalledTimes(1);
    expect(editor.innerHTML).toContain('http://localhost:8888/pixel/tk_test');
  });

  it('a click + a Cmd+Enter within the same tick fires mint only once (double-fire guard)', async () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    let resolveMint: ((v: { token: string; pixel_url: string }) => void) | undefined;
    const mintFn = vi.fn(
      () =>
        new Promise<{ token: string; pixel_url: string }>((resolve) => {
          resolveMint = resolve;
        }),
    ) as unknown as MintFn;
    hookDialog(dialog, { mintFn });

    const sendBtn = dialog.querySelector<HTMLElement>('div[role="button"]')!;
    const editor = dialog.querySelector<HTMLElement>('div[role="textbox"]')!;
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(mintFn).toHaveBeenCalledTimes(1);

    // Resolve the in-flight mint so the test cleans up.
    resolveMint?.({ token: 't', pixel_url: 'http://x/pixel/t' });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('a non-Send-combo keypress is ignored', async () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    const mintFn = fakeMint();
    hookDialog(dialog, { mintFn });

    const editor = dialog.querySelector<HTMLElement>('div[role="textbox"]')!;
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mintFn).not.toHaveBeenCalled();
  });

  it('does not crash when the dialog is missing a Send button', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML =
      '<div role="textbox" aria-label="Message Body" contenteditable="true"></div>';
    document.body.appendChild(dialog);
    expect(hookDialog(dialog, { mintFn: fakeMint() })).toBe(false);
  });
});
