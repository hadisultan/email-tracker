import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findBodyEditor,
  findComposeDialogs,
  findSendButton,
  GMAIL_SELECTORS,
  readRecipients,
  readSubject,
} from '../src/content/gmail-selectors.js';

// Minimal Gmail compose-dialog fixture. Mirrors the attribute pattern
// Gmail uses in the desktop UI as of 2026: `role="dialog"`, a Send
// button with `data-tooltip` starting with "Send", a body editor with
// `role="textbox"` + aria-label containing "Message Body", and chip
// inputs with name="to"/"cc"/"bcc" plus a subject input.
function makeComposeFixture(opts: {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyHtml?: string;
} = {}): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `
    <input name="to" value="${opts.to ?? ''}" />
    <input name="cc" value="${opts.cc ?? ''}" />
    <input name="bcc" value="${opts.bcc ?? ''}" />
    <input name="subjectbox" value="${opts.subject ?? ''}" />
    <div role="textbox" aria-label="Message Body" contenteditable="true">${opts.bodyHtml ?? ''}</div>
    <div role="button" data-tooltip="Send ‪(⌘Enter)‬">Send</div>
  `;
  return dialog;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('GMAIL_SELECTORS', () => {
  it('exports the expected selector keys', () => {
    expect(Object.keys(GMAIL_SELECTORS).sort()).toEqual(
      [
        'bccField',
        'bodyEditor',
        'ccField',
        'composeDialog',
        'recipientChip',
        'sendButton',
        'subjectInput',
        'toField',
      ].sort(),
    );
  });
});

describe('findComposeDialogs', () => {
  it('finds a single mounted compose dialog', () => {
    document.body.appendChild(makeComposeFixture({ subject: 'hi' }));
    const found = findComposeDialogs(document);
    expect(found.length).toBe(1);
  });

  it('finds two compose dialogs simultaneously', () => {
    document.body.appendChild(makeComposeFixture({ subject: 'a' }));
    document.body.appendChild(makeComposeFixture({ subject: 'b' }));
    expect(findComposeDialogs(document).length).toBe(2);
  });

  it('returns nothing when the document has no compose dialogs', () => {
    document.body.innerHTML = '<div>just a page</div>';
    expect(findComposeDialogs(document).length).toBe(0);
  });

  it('ignores generic role="dialog" without compose internals (e.g. confirm dialogs)', () => {
    const stranger = document.createElement('div');
    stranger.setAttribute('role', 'dialog');
    stranger.innerHTML = '<button>OK</button>';
    document.body.appendChild(stranger);
    expect(findComposeDialogs(document).length).toBe(0);
  });

  it('returns nothing for a mobile-view fixture (no Send button + body editor pair)', () => {
    // Mobile Gmail uses a different DOM that doesn't expose the same
    // compose-dialog markers — give the fixture neither the Send button
    // tooltip nor the contenteditable body to confirm rejection.
    const mobile = document.createElement('div');
    mobile.innerHTML = `
      <div class="mobile-compose">
        <input name="to" />
        <textarea name="body"></textarea>
        <button>Send</button>
      </div>
    `;
    document.body.appendChild(mobile);
    expect(findComposeDialogs(document).length).toBe(0);
  });
});

describe('findSendButton / findBodyEditor', () => {
  it('locates the Send button and body editor inside a compose dialog', () => {
    const dialog = makeComposeFixture();
    document.body.appendChild(dialog);
    expect(findSendButton(dialog)).not.toBeNull();
    expect(findBodyEditor(dialog)).not.toBeNull();
  });
});

describe('readSubject', () => {
  it('reads the subject input value', () => {
    const dialog = makeComposeFixture({ subject: 'hello world' });
    document.body.appendChild(dialog);
    expect(readSubject(dialog)).toBe('hello world');
  });

  it('returns empty string when subject is missing', () => {
    const dialog = makeComposeFixture({});
    document.body.appendChild(dialog);
    expect(readSubject(dialog)).toBe('');
  });
});

describe('readRecipients', () => {
  it('reads To recipients', () => {
    const dialog = makeComposeFixture({ to: 'a@x.com' });
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['a@x.com']);
  });

  it('combines To + Cc + Bcc', () => {
    const dialog = makeComposeFixture({
      to: 'a@x.com',
      cc: 'b@x.com',
      bcc: 'c@x.com',
    });
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('splits comma-separated values within a single field', () => {
    const dialog = makeComposeFixture({ to: 'a@x.com, b@x.com,c@x.com' });
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('returns empty array when no recipient fields are filled in', () => {
    const dialog = makeComposeFixture({});
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual([]);
  });

  // Modern Gmail (post-2026 rollout): committed recipients are chip
  // elements with an `email="..."` attribute; the legacy `name="to"`
  // input is now a value-less <div>. The selector must still find the
  // recipient.
  it('reads recipients from chip [email] attributes (modern Gmail)', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `
      <div name="to">
        <span email="alice@example.com">Alice</span>
        <span email="bob@example.com">Bob</span>
      </div>
      <input name="subjectbox" value="hi" />
      <div role="textbox" aria-label="Message Body" contenteditable="true"></div>
      <div role="button" data-tooltip="Send">Send</div>
    `;
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('ignores [email] elements inside an autocomplete role="listbox"', () => {
    // Gmail's recently-contacted autocomplete dropdown mounts
    // suggestion items with `role="option" email="..."` inside a
    // `role="listbox"`. Those are not committed recipients and must
    // not leak into the send. Top-level chips OUTSIDE the listbox
    // (where real Gmail places committed chips) are still captured.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `
      <span email="alice@example.com">Alice</span>
      <div role="listbox" aria-label="Search results">
        <div role="option" email="suggest1@x.com">Suggest 1</div>
        <div role="option" email="suggest2@x.com">Suggest 2</div>
        <div role="option" email="suggest3@x.com">Suggest 3</div>
      </div>
      <input name="subjectbox" value="hi" />
      <div role="textbox" aria-label="Message Body" contenteditable="true"></div>
      <div role="button" data-tooltip="Send">Send</div>
    `;
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['alice@example.com']);
  });

  it('de-duplicates when a chip and a legacy input value both list the same address', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `
      <input name="to" value="alice@example.com" />
      <span email="alice@example.com">Alice</span>
      <input name="subjectbox" value="hi" />
      <div role="textbox" aria-label="Message Body" contenteditable="true"></div>
      <div role="button" data-tooltip="Send">Send</div>
    `;
    document.body.appendChild(dialog);
    expect(readRecipients(dialog)).toEqual(['alice@example.com']);
  });
});
