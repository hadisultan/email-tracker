---
title: Gmail's image proxy fetches the tracking pixel at delivery, not just on open
date: 2026-05-09
category: logic-errors
module: functions/lib/tag-classifier.ts
problem_type: logic_error
component: email_processing
symptoms:
  - "Spurious 'Opened just now' push fires ~90s after every send"
  - "Dashboard shows 2-3 opens for a tracker email before recipient ever opens it"
  - "Hits with `proxy_label='google'` arrive at +15s and +25-50s after send, all tagged `none`"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - gmail
  - tracking-pixel
  - classification
  - googleimageproxy
  - push-notifications
---

# Gmail's image proxy fetches the tracking pixel at delivery, not just on open

## Problem

For every email sent via Gmail, two pixel hits arrived from Google's image proxy (IPs in `66.249.0.0/16` and `74.125.0.0/16`, UA "via ggpht.com GoogleImageProxy") — one at ~+15s and another at ~+25-50s — *before* the recipient (or sender, in self-send tests) ever opened the message. The classifier left them tagged `tag='none'`, set a `notify_after` timer, and a spurious "Opened just now" Web Push fired ~90 seconds later for every single send. Real recipient opens were drowned in this noise.

## Symptoms

- 2-3 hits appear on the dashboard before the user opens the email.
- All extra hits have `proxy_label='google'` (already tagged by the proxy-CIDR check).
- Push notifications fire 90s after every send regardless of whether the recipient opened.
- `pixel_hits.tag = 'none' AND ph.notify_after IS NOT NULL` rows accumulate for the user's own sent threads.

## What Didn't Work

1. **Trying to suppress via the self-view beacon** — assumed the user's Chrome viewing the thread would fire a beacon and the classifier would tag the proxy hits as `self_view_desktop`. But beacons fire only on user-driven views, not at delivery; the proxy fetches at delivery happen before any view.
2. **Extending the existing 10s `likely_prefetch` window to 60s for ALL hits** — would also silence the rare case of a recipient opening the email within 60s of receiving it (which is a real "open" we want to surface).

## Solution

Add a `proxy_label='google'` rule to `classifyHit`, scoped to the first 60 seconds:

```ts
// functions/lib/tag-classifier.ts
export function classifyHit(input: ClassifyHitInput): PixelTag {
  if (input.proxyLabel === 'apple_mpp') return 'none';

  // NEW: Gmail's image proxy fires at delivery (~+15s scan + ~+25-50s
  // follow-up). After that, Gmail caches the image so further proxy
  // hits are rare. Treat any google-proxy hit inside the first minute
  // as a delivery prefetch.
  if (input.proxyLabel === 'google' && input.sentAt) {
    const sinceSendMs = input.hitAt.getTime() - input.sentAt.getTime();
    if (sinceSendMs >= 0 && sinceSendMs < 60_000) {
      return 'likely_prefetch';
    }
  }

  if (input.sentAt) {
    const sinceSendMs = input.hitAt.getTime() - input.sentAt.getTime();
    if (sinceSendMs >= 0 && sinceSendMs < PREFETCH_WINDOW_MS) {
      return 'likely_prefetch';
    }
  }
  // ... beacon check, default 'none' ...
}
```

`likely_prefetch` does not get a `notify_after`, so no push fires. The hit still appears on the dashboard under "All" / "Hidden" — it isn't lost, just demoted.

## Why This Works

Gmail's image proxy is **not** a recipient-driven event. It runs:

1. Immediately after delivery (a "scan" pass for spam/security checks) — typically +5-20s.
2. A second pass within the first ~60s, often for proxy-cache warming.

After that, Gmail caches the image and serves subsequent renders from cache without re-hitting the origin. So real recipient opens past +60s rarely produce another `proxy_label='google'` hit at all (and when they do, those are still legitimate signals worth surfacing — `tag='none'` flows through correctly).

Apple MPP is intentionally treated differently (`tag='none'`, counted as an open) because for Apple Mail clients, the MPP fetch *is* the open signal — Apple Mail won't render the image client-side.

## Prevention

- For any new tracker source (Outlook MPP, Yahoo, etc.), classify proxy fetches based on observed timing patterns, not just IP/UA fingerprinting. A proxy can be a delivery scanner OR an on-render fetcher — those need different tags.
- Add a unit test in `tag-classifier.test.ts` per proxy_label x time-window cell of the classifier's truth table.
- Periodically `SELECT proxy_label, tag, COUNT(*) FROM pixel_hits GROUP BY 1, 2` in production: if a `(proxy_label, tag)` combination grows unexpectedly, classification drift is happening.

## Related Issues

- See `docs/solutions/logic-errors/gmail-self-send-inbox-url-pattern-2026-05-09.md` — companion bug discovered during the same Step 8 smoke test.
- See `docs/solutions/best-practices/classifier-verdict-vs-raw-signals-2026-05-09.md` — the architectural rule that drove this fix to be in the classifier rather than in the dashboard or push pipeline.
