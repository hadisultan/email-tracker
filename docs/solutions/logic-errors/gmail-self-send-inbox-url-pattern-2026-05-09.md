---
title: Gmail self-sends use #inbox/<id> URL, not #sent/<id>
date: 2026-05-09
category: logic-errors
module: extension/src/content/thread-detect.ts
problem_type: logic_error
component: email_processing
symptoms:
  - "Self-view beacon never fires when user opens their own sent email"
  - "self_view_beacons table has zero rows after a self-send + open test"
  - "Pixel hits on user's own sent threads stay tagged 'none' instead of 'self_view_desktop'"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - gmail
  - chrome-extension
  - url-routing
  - self-view
  - thread-detect
---

# Gmail self-sends use #inbox/<id> URL, not #sent/<id>

## Problem

The Chrome extension's `thread-detect.ts` is responsible for posting a "self-view beacon" to the backend when the user opens one of their own sent threads, so the resulting pixel hit can be tagged `self_view_desktop` (instead of being notified as a recipient open). The detection regex matched `#sent/<thread-id>` and `#label/sent/<thread-id>`, deliberately *not* `#inbox/<thread-id>` — the original comment cited a false-positive concern about the user reading inbound replies on their own threads. As a result, when the user mailed themselves (a common testing path) or viewed self-sent emails from the inbox view, the beacon never fired and self-views were misclassified as recipient opens.

## Symptoms

- `SELECT count(*) FROM self_view_beacons WHERE received_at > now() - interval '1 hour'` returns 0 even after the user just clicked their own sent message.
- Pixel hits on self-sent threads accumulate with `tag='none'`, `notify_after IS NOT NULL`, and (without the proxy-label fix) trigger spurious push notifications.
- The Gmail URL bar shows `#inbox/<long-id>` (e.g. `#inbox/QgrcJHrjBQfqwnMJbWkcbwkQWjRzWJtTDTQ`) when a self-sent message is open, not `#sent/...`.

## What Didn't Work

1. **Assuming the URL would be `#sent/<id>` for self-sends** — Gmail actually files self-sends in BOTH the `Sent` and `Inbox` labels. When the user clicks the message from anywhere — Inbox, search results, Important — the URL becomes `#inbox/<thread-id>`, not `#sent/<thread-id>`.
2. **Avoiding `#inbox/<id>` to prevent the inbound-reply false-positive** — the reasoning was: "if the user views an inbound reply on a thread they originally sent, the beacon would fire and wrongly suppress the recipient's pixel hit." That risk is real but small (see Why This Works), and the cost of avoiding it (zero working self-view detection on the most common testing path) is much higher.

## Solution

Add `#inbox/<id>` to the matched patterns:

```ts
// extension/src/content/thread-detect.ts
const SENT_HASH_PATTERNS: readonly RegExp[] = [
  /^#sent\/([^/?]+)$/i,
  /^#label\/sent\/([^/?]+)$/i,
  /^#inbox\/([^/?]+)$/i,   // self-sends and self-views from inbox
];
```

Add tests covering both the new positive case and a representative real-world Gmail thread ID:

```ts
it('detects #inbox/<thread-id> (self-sends and inbound-reply views)', () => {
  expect(detectSelfThreadView({ hash: '#inbox/THREAD123' })).toEqual({
    threadId: 'THREAD123',
  });
});

it('detects long modern Gmail thread IDs (Qgrc... form)', () => {
  expect(
    detectSelfThreadView({
      hash: '#inbox/QgrcJHrjBQfqwnMJbWkcbwkQWjRzWJtTDTQ',
    }),
  ).toEqual({ threadId: 'QgrcJHrjBQfqwnMJbWkcbwkQWjRzWJtTDTQ' });
});
```

If your test suite has any "negative-sentinel" tests that previously used `#inbox/<id>` to mean "not a self-thread" (we did, in `beacon-orchestrator.test.ts`), update those to use `#label/Foo/<id>` or `#drafts/<id>` instead.

## Why This Works

Gmail self-sends (sender == one of the recipients) are filed in BOTH the Sent and Inbox labels. The URL surface for a self-sent thread is `#inbox/<thread-id>` for almost any access path — clicking from inbox, opening from a notification, deep-linking from search.

The false-positive concern about inbound replies is bounded by two existing safeguards:

1. The classifier (`tag-classifier.ts`) only counts beacons received within a 5-minute window leading up to the hit. A user who viewed their inbox hours ago does not shadow a fresh recipient open.
2. The backend `/api/beacon` endpoint independently validates ownership: only threads that contain one of the caller's own messages get persisted. So an `#inbox/<id>` view of a purely-inbound thread (someone else's thread) is silently dropped without recording a beacon.

The residual case is "user views an inbound reply on their own outbound thread within 5 minutes of the recipient's pixel hit" — narrow enough to accept for a personal-use tracker, and even in production this is a soft failure (a false `self_view_desktop` tag) rather than a hard one.

## Prevention

- For any Gmail URL pattern matching, test against the **literal URL Gmail surfaces** (paste it in from the address bar of an actual session), not what you assume Gmail uses based on label semantics.
- Modern Gmail thread IDs come in two forms: short (`thread-a:r1234567890`) and long (`QgrcJ...` Base64-like). Make sure regexes accept both via `[^/?]+` or equivalent.
- When a regex deliberately excludes a pattern based on a behavior assumption, add a comment + test asserting the behavior — so when the assumption breaks (or the trade-off shifts), the inverse is easy to find and flip.

## Related Issues

- See `docs/solutions/logic-errors/gmail-image-proxy-delivery-prefetch-classification-2026-05-09.md` — companion fix from the same Step 8 smoke test session.
