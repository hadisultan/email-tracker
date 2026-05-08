// Content-script orchestrator. Wires Gmail compose dialogs to the
// pure compose-handler. The pieces:
//
//   1. MutationObserver on document.body discovers compose dialogs as
//      Gmail mounts them. Each new compose dialog gets a capture-phase
//      click listener on its Send button and a keydown listener on its
//      body editor (for Ctrl+Enter / Cmd+Enter).
//
//   2. The click/keydown listener intercepts the user's send, calls
//      `handleComposeSend` (pure) to produce mint+inject, writes the
//      new HTML back to the body editor, then dispatches a synthetic
//      click on the Send button so Gmail completes the send.
//
//   3. Two WeakSets prevent double-attach (`hookedSendButtons`) and
//      double-fire (`inFlightSends`). The synthetic click is allowed
//      through by removing our own listener for the duration of the
//      dispatch; the inFlightSends sentinel guards against the rare
//      click+keydown double-fire on the user's side.

import {
  findBodyEditor,
  findComposeDialogs,
  findSendButton,
  readRecipients,
  readSubject,
} from './gmail-selectors.js';
import {
  handleComposeSend,
  type HandleComposeSendInput,
  type MintFn,
} from './compose-handler.js';
import { mint } from '../lib/api.js';

const hookedSendButtons = new WeakSet<HTMLElement>();
const hookedDialogs = new WeakSet<HTMLElement>();
const inFlightSends = new WeakSet<HTMLElement>();

interface DialogBindings {
  dialog: HTMLElement;
  sendBtn: HTMLElement;
  bodyEditor: HTMLElement;
  clickHandler: (e: MouseEvent) => void;
  keydownHandler: (e: KeyboardEvent) => void;
}

const dialogBindings = new WeakMap<HTMLElement, DialogBindings>();

const defaultMintFn: MintFn = async (body, idemKey, signal) => {
  const result = await mint(body, idemKey, signal);
  return { token: result.token, pixel_url: result.pixel_url };
};

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function readThreadIdFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  // Gmail thread URLs look like `https://mail.google.com/mail/u/0/#inbox/<thread-id>`.
  const m = /#[^/]+\/([^/?]+)/.exec(location.hash);
  return m && m[1] ? m[1] : null;
}

export function hookDialog(
  dialog: HTMLElement,
  opts: { mintFn?: MintFn } = {},
): boolean {
  if (hookedDialogs.has(dialog)) return false;
  const sendBtn = findSendButton(dialog);
  const bodyEditor = findBodyEditor(dialog);
  if (!sendBtn || !bodyEditor) return false;
  if (hookedSendButtons.has(sendBtn)) {
    // Same Send button already wired (could be a re-render of the same
    // dialog under a different parent ref). Mark the new dialog ref
    // hooked so we don't re-enter.
    hookedDialogs.add(dialog);
    return false;
  }

  const mintFn = opts.mintFn ?? defaultMintFn;

  const trigger = async (cause: 'click' | 'keydown'): Promise<void> => {
    if (inFlightSends.has(dialog)) return;
    inFlightSends.add(dialog);
    try {
      const input: HandleComposeSendInput = {
        recipients: readRecipients(dialog),
        subject: readSubject(dialog),
        bodyHtml: bodyEditor.innerHTML,
        threadId: readThreadIdFromUrl(),
        messageId: null,
        mintFn,
        now: () => new Date(),
        idempotencyKey: uuid(),
      };
      const result = await handleComposeSend(input);
      if (!result.mintError) {
        bodyEditor.innerHTML = result.newBodyHtml;
      } else {
        console.warn(
          JSON.stringify({
            source: 'email-tracker',
            stage: 'compose-send',
            cause,
            error: result.mintError,
          }),
        );
      }
      // Dispatch the synthetic Send click without re-entering our own
      // listener: temporarily remove the capture handler, click, re-add.
      sendBtn.removeEventListener('click', clickHandler, { capture: true });
      sendBtn.click();
      sendBtn.addEventListener('click', clickHandler, { capture: true });
    } finally {
      inFlightSends.delete(dialog);
    }
  };

  const clickHandler = (e: MouseEvent): void => {
    if (inFlightSends.has(dialog)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    void trigger('click');
  };

  const keydownHandler = (e: KeyboardEvent): void => {
    const isSendCombo =
      (e.key === 'Enter' || e.code === 'Enter') && (e.ctrlKey || e.metaKey);
    if (!isSendCombo) return;
    if (inFlightSends.has(dialog)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    void trigger('keydown');
  };

  sendBtn.addEventListener('click', clickHandler, { capture: true });
  bodyEditor.addEventListener('keydown', keydownHandler, { capture: true });

  hookedSendButtons.add(sendBtn);
  hookedDialogs.add(dialog);
  dialogBindings.set(dialog, {
    dialog,
    sendBtn,
    bodyEditor,
    clickHandler,
    keydownHandler,
  });
  return true;
}

let observer: MutationObserver | null = null;

export function startObserver(opts: { mintFn?: MintFn } = {}): void {
  if (observer || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return;
  }
  for (const dialog of findComposeDialogs(document)) {
    hookDialog(dialog, opts);
  }
  observer = new MutationObserver(() => {
    for (const dialog of findComposeDialogs(document)) {
      hookDialog(dialog, opts);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function stopObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

export const _internals = {
  hookedSendButtons,
  hookedDialogs,
  inFlightSends,
  dialogBindings,
};

declare const chrome: { runtime?: { id?: string } } | undefined;
if (
  typeof document !== 'undefined' &&
  typeof chrome !== 'undefined' &&
  chrome?.runtime?.id
) {
  console.log('email-tracker content script loaded');
  startObserver();
}
