// Gmail DOM selector configuration. Centralizing selectors here lets us
// retune in one file when Gmail's UI shifts. Tests feed captured fixture
// HTML through these selectors to confirm the patterns still match.
//
// All selectors are scoped to the Gmail desktop web UI (mail.google.com).
// Mobile (m.google.com / inbox.google.com) and the iOS/Android apps are
// out of scope for this extension.

export const GMAIL_SELECTORS = {
  // Top-level compose dialog. Gmail uses `role="dialog"` on the floating
  // compose window. Multiple dialogs can be open simultaneously.
  composeDialog: 'div[role="dialog"]',

  // Primary Send button inside a compose dialog. Gmail decorates it with
  // a `data-tooltip` starting with "Send" (the rest of the tooltip is a
  // localized hotkey hint, e.g. "Send ‪(⌘Enter)‬").
  sendButton: 'div[role="button"][data-tooltip^="Send"]',

  // Recipient inputs and chips. Gmail's full-screen compose renders
  // committed recipients as DOM elements with an `email="..."` attribute
  // (the chip). The legacy `name="to"` / `name="cc"` / `name="bcc"`
  // inputs still exist but are now `<div>` containers rather than the
  // value-bearing inputs they once were, and the visible input
  // (`aria-label="To recipients"`) is cleared after a chip commits.
  // We therefore read recipients from the chip `[email]` attribute,
  // falling back to legacy input `value` (for older Gmail variants and
  // test fixtures).
  toField: '[name="to"]',
  ccField: '[name="cc"]',
  bccField: '[name="bcc"]',
  recipientChip: '[email]',

  // Subject is a regular text input.
  subjectInput: 'input[name="subjectbox"]',

  // Body editor — contenteditable div. The aria-label includes "Message
  // Body" in English and the localized equivalent in other locales; the
  // `contains` form gives us locale tolerance.
  bodyEditor: 'div[role="textbox"][aria-label*="Message Body"]',
} as const;

export type GmailSelectorKey = keyof typeof GMAIL_SELECTORS;

// Find every compose dialog currently in the document. Used by the
// observer to discover dialogs on initial page load and after each
// document.body mutation.
export function findComposeDialogs(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(GMAIL_SELECTORS.composeDialog),
  ).filter((el) => isLikelyComposeDialog(el));
}

function isLikelyComposeDialog(el: HTMLElement): boolean {
  // A `role="dialog"` is a generic ARIA role and Gmail uses it for many
  // popovers (e.g. confirm dialogs, contact pickers). Constrain to
  // dialogs that look like compose: the body editor and a Send button
  // are both present.
  const hasBody = el.querySelector(GMAIL_SELECTORS.bodyEditor) !== null;
  const hasSend = el.querySelector(GMAIL_SELECTORS.sendButton) !== null;
  return hasBody && hasSend;
}

export function findSendButton(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>(GMAIL_SELECTORS.sendButton);
}

export function findBodyEditor(dialog: HTMLElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>(GMAIL_SELECTORS.bodyEditor);
}

export function readSubject(dialog: HTMLElement): string {
  const input = dialog.querySelector<HTMLInputElement>(
    GMAIL_SELECTORS.subjectInput,
  );
  return input?.value ?? '';
}

// Read recipients from the compose dialog. Modern Gmail (full-screen
// and inline) commits each recipient as a chip element with an
// `email="..."` attribute — this is the source of truth for committed
// addresses (the visible input is cleared after each chip).
//
// We additionally read legacy `name="to"`/`cc"`/`bcc"` input values for
// the rare case where a hidden input still carries a value (some Gmail
// rollouts, and our test fixtures), then de-duplicate.
export function readRecipients(dialog: HTMLElement): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const chip of dialog.querySelectorAll<HTMLElement>(
    GMAIL_SELECTORS.recipientChip,
  )) {
    const email = chip.getAttribute('email');
    if (email) push(email);
  }

  for (const sel of [
    GMAIL_SELECTORS.toField,
    GMAIL_SELECTORS.ccField,
    GMAIL_SELECTORS.bccField,
  ]) {
    const fields = dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(sel);
    for (const f of fields) {
      const v = (f as { value?: unknown }).value;
      if (typeof v === 'string' && v.length > 0) {
        for (const piece of v.split(',')) push(piece);
      }
    }
  }

  return out;
}
