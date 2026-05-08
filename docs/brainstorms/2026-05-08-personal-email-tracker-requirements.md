---
date: 2026-05-08
topic: personal-email-tracker
---

# Personal Email Tracker (Mailsuite-style, Self-Hosted, Free-Tier)

## Problem Frame

I want a personal, self-hosted equivalent of Mailsuite Pro / Mailtrack for my own
Gmail account. It should tell me when emails I send are opened, with timestamps
and approximate location info, without paying a subscription. Volume is low
(<50 sends/day on average, single user), so the entire thing must fit inside the
free tiers of Netlify and Supabase.

The mechanism is the standard 1×1 tracking pixel injected into outgoing HTML
email, with a backend that logs hits and a dashboard that shows me what's
happening. A Chrome extension handles pixel injection in Gmail's compose UI so
tracking is transparent on every send. A scheduled backend poller of Gmail's
History API filters out the noise of me reading my own sent mail on any device.

## Architecture (high level)

```
┌──────────────────┐                                  ┌────────────────────┐
│  Chrome ext      │  mint token + capture metadata   │ Netlify Functions  │
│  (Gmail web UI)  │ ───────────────────────────────► │  (mint, beacon,    │
│  - inject pixel  │                                  │   pixel, gmail-    │
│  - self-view     │  beacon "I'm viewing thread X"   │   poll, push,      │
│    beacon        │ ───────────────────────────────► │   dashboard API)   │
└──────────────────┘                                  └─────────┬──────────┘
                                                                │
                                                                ▼
                  ┌──────────────────────────────────┐    ┌──────────────┐
                  │  Recipient's mail client         │    │  Supabase    │
                  │  loads pixel via provider proxy  │    │  (Postgres + │
                  │  ───────────────────────────────►│    │   Auth)      │
                  │  GET /pixel/<token>              │    └──────────────┘
                  └──────────────────────────────────┘           ▲
                                                                 │
                  ┌──────────────────────────────────┐           │
                  │  Gmail API (History list)        │   poll    │
                  │  user's sent-thread read state   │ ◄─────────┘
                  └──────────────────────────────────┘

                  ┌──────────────────────────────────┐
                  │  Static dashboard (Netlify CDN)  │
                  │  + Web Push notifications        │
                  └──────────────────────────────────┘
```

## Requirements

> **Note on "open" semantics.** In this tool, "open" means the email's images
> were fetched by some client renderer. This is a heuristic, not a guarantee
> that a human visually read the message: modern clients prefetch on delivery,
> render in preview/summary panes, and increasingly run AI summaries that
> trigger image loads. Treat the data as a strong signal, not ground truth.

**Pixel injection (Chrome extension)**
- R1. The extension runs as an unpacked Manifest V3 Chrome extension, loaded
  locally on my own machine — no Chrome Web Store distribution required.
- R2. On every Gmail compose Send, the extension mints a tracking token via the
  backend and injects a 1×1 transparent image referencing
  `https://<custom-domain>/pixel/<token>` into the outgoing HTML body.
- R3. At mint time, the extension also sends to the backend the email's subject,
  the To/Cc/Bcc recipient list, the Gmail thread/message ID, and the local send
  timestamp, so the dashboard can display meaningful context per token.
- R4. Multi-recipient sends use a single shared pixel (no mail-merge fan-out).
  The dashboard makes clear that opens on multi-recipient sends are not
  attributable to a specific recipient.
- R5. The extension watches when I open one of my own sent threads in Gmail web
  and sends a "self-view beacon" to the backend with the thread ID, so hits in
  a short window can be tagged as self-opens.

**Tracking endpoint and event capture**
- R6. The pixel endpoint serves a fully transparent 1×1 image with
  `Cache-Control: no-store, must-revalidate` and a per-request cache-buster, so
  Gmail's image proxy is unlikely to cache repeat opens.
- R7. Every pixel hit records: token, server timestamp, IP address, full
  user-agent string, and the Netlify-provided geo data (country, city,
  timezone, lat/lon).
- R8. Repeat opens on the same token produce additional rows (one row per hit),
  so the dashboard can show the full timeline (e.g., "Opened 3 times: 9:02,
  11:15, 14:40").
- R9. Hits whose IP falls inside known Google / Apple / Microsoft image-proxy
  ranges are tagged in the data so the dashboard can label them honestly as
  "via provider proxy" rather than misrepresenting them as a recipient
  location.

**Self-open suppression (Mailtrack-parity)**
- R10. Hits arriving within a short configurable window of the original send
  (default a few seconds to a couple of minutes) are tagged `likely_prefetch`,
  to absorb Gmail-side image prefetch on delivery.
- R11. Hits arriving inside the window of an extension self-view beacon for the
  matching thread are tagged `self_open_desktop`.
- R12. A scheduled backend job polls the Gmail History API (`users.history.list`)
  for the authorized user every 1–2 minutes. When it detects that one of my
  sent threads has just been read by me on any device (e.g., `UNREAD` removed
  via `messageRead`), it tags any recent matching pixel hits as
  `self_open_mobile_or_other`.
- R13. Suppression is non-destructive: every hit is stored. Self/prefetch
  classifications are stored as tags. The dashboard's default view hides
  self/prefetch hits but lets me toggle "show all" to inspect the raw data.

**Dashboard**
- R14. A standalone web dashboard (static site on Netlify) shows my sent emails
  grouped by token, with: subject, recipients, send time, open count
  (excluding tagged self/prefetch by default), each open's timestamp, and each
  open's geo with the proxy/likely-recipient label.
- R15. Authentication is via Supabase Auth with Google OAuth, restricted to my
  own Google account. The Gmail API access used for History polling reuses the
  same OAuth grant.
- R16. The dashboard offers a manual "delete this tracked message and its
  events" action, in case I want to purge a record. *(Could defer to v1.5 —
  not core to "did they open it?")*

**Notifications**
- R17. The dashboard offers Web Push notification opt-in (standard VAPID-based
  Web Push). When an open event is recorded that is *not* tagged self/prefetch,
  the backend sends a push to all my registered subscriptions.
- R18. Push notification body includes the email subject, the recipient (or
  "multiple recipients" for multi-recipient sends), and "Opened just now."

**Hosting and storage**
- R19. The whole system runs on free tiers: Netlify (static dashboard +
  Functions + scheduled functions + automatic geo) and Supabase (Postgres +
  Auth). No paid services required at expected volume.
- R20. The pixel endpoint is served from a custom domain I own (e.g.,
  `track.mydomain.com`) rather than a `*.netlify.app` subdomain, to look more
  legitimate to spam filters and avoid coupling the URL to platform branding.
  *(Could defer to v1.5 — `*.netlify.app` works for an MVP.)*

**Backend endpoint authentication**
- R21. All backend endpoints used by the Chrome extension (token mint,
  self-view beacon, push-subscription registration) require authentication
  bound to my single user identity. The pixel endpoint itself remains public
  by necessity (recipients' mail clients call it), but every other endpoint
  is gated. Without this, anyone who discovers an endpoint URL could mint
  tracking tokens, suppress real opens by spamming fake self-view beacons,
  or register their own push subscriptions. The specific mechanism (stored
  Supabase session token, per-install shared secret, reused Google OAuth
  bearer, etc.) is a planning decision.

**System health and observability**
- R22. The dashboard surfaces the system's basic health so silent breakage
  is visible: last successful Gmail History poll timestamp, last token mint
  timestamp, last pixel hit timestamp, and Gmail OAuth grant status. A
  banner appears when any of these is older than expected (e.g., no mints
  in 7 days while you're actively sending email, or no successful poll in
  10 minutes). Without this, a Gmail redesign that breaks the extension's
  send-hook or an expired OAuth grant would silently kill tracking and the
  dashboard would just look quiet.

## Success Criteria

- Sending a Gmail to a non-Gmail-Mail-Privacy recipient and having them open it
  produces an event in my dashboard within seconds, with a recognizable geo
  label.
- Sending a Gmail to a Gmail recipient and having them open it on Gmail web or
  Gmail mobile produces an event tagged with the Gmail-proxy label.
- Reading my own sent thread on desktop Gmail does not produce a counted open
  in the dashboard's default view.
- Reading my own sent thread on the Gmail mobile app does not produce a counted
  open in the dashboard's default view (within ~2 minutes of poll latency).
- A typical day at <50 sends and ~150 events stays comfortably inside Netlify
  and Supabase free tiers indefinitely.
- I can open the dashboard, sign in once with Google, and immediately see what
  I sent today and which of those have been opened.

## Scope Boundaries

- **Out: link / click tracking.** v1 is opens only. Adding click tracking would
  require rewriting every link in outgoing email through a redirect endpoint
  and storing per-link mappings — meaningful extra surface area, deferred.
- **Out: per-recipient attribution on multi-recipient sends.** No mail-merge
  fan-out. Multi-recipient sends get one shared pixel and "someone opened it"
  semantics.
- **Out: forward attribution.** Forwarded copies of tracked emails will fire
  the original pixel and look like additional opens of the same token. No
  attempt is made to detect forwards.
- **Out: inline Gmail UI.** No green checkmarks inside Gmail's thread list or
  message view. All status is in the standalone dashboard plus push.
- **Out: Gmail mobile pixel injection.** The extension only runs in desktop
  Chrome on Gmail web. Emails sent from Gmail mobile or other clients are not
  tracked. (You can still receive open events on previously-tracked emails
  from any device.)
- **Out: multi-user / SaaS.** Single-user, single-Gmail-account tool. No
  signup flow, no tenancy, no billing.
- **Out: rich device/UA fingerprinting beyond what Netlify geo provides.**
- **Out: Chrome Web Store distribution.** Unpacked extension only.

## Key Decisions

- **Injection = Chrome extension (unpacked):** chosen over bookmarklet, Gmail
  add-on, web composer, and manual paste. Side-loading as unpacked removes the
  worst part of extension dev (publishing) and gives true Mailsuite-parity
  transparency on every send.
- **Mailtrack-parity self-open suppression up front:** chosen over the lean
  "extension beacon + time window" path. Adds Gmail History API polling now
  rather than later, so mobile self-opens are filtered from day one.
- **Single shared pixel on multi-recipient sends:** chosen over mail-merge
  fan-out. Personal email is mostly 1:1; mail-merge breaks normal Gmail
  threading and is not worth the complexity for this use case.
- **Standalone dashboard + Web Push, no inline Gmail UI:** chosen over inline
  checkmarks. Inline UI requires the extension to render into and stay in sync
  with Gmail's DOM for every visible thread. Out of scope for v1.
- **Netlify Functions + Supabase Postgres + Netlify static dashboard:** chosen
  over Turso, Netlify Blobs, and AWS. Best dev velocity at this scale; SQL is
  honest about the relational shape (messages, recipients, opens); free tiers
  swallow the data forever; auth is bundled.
- **Google OAuth via Supabase Auth:** chosen over magic links and shared
  secrets. Reuses the same Google identity already needed for Gmail API
  access; one sign-in gates both the dashboard and the Gmail API grant.
- **Tag-don't-hide for self/prefetch detection:** every hit is stored; tags
  drive default filtering but the raw history is always inspectable.

## Dependencies / Assumptions

- I own a custom domain I can point at Netlify for the pixel endpoint.
- I'm willing to set up a Google Cloud project, configure an OAuth consent
  screen (in "Testing" mode is fine for a single user), and enable the Gmail
  API — one-time paperwork.
- Gmail OAuth refresh tokens are stored in Supabase, encrypted at rest by
  Supabase's defaults. Single-user deployment, so no per-tenant key
  management is needed.
- Netlify's automatic geo data on incoming Function requests remains available
  on the free tier (currently true; this is the key reason geo is free).
- Supabase free tier remains adequate (currently 500MB DB, more than enough
  for years of events at this volume).
- Volume stays roughly within stated bounds; if it grew 100×, this design
  would still fit but would need a re-check of free-tier ceilings.

## Outstanding Questions

### Resolve Before Planning

(none — every open product question above has a chosen direction)

### Deferred to Planning

- [Affects R21][Technical] How the Chrome extension authenticates to the
  backend (mint/beacon/push-subscribe endpoints): reuse the Supabase
  session/JWT obtained via Google OAuth, mint a per-install shared secret
  on first connect, or proxy through a signed Google ID token. Decide
  during planning based on Supabase Auth's extension-friendliness.
- [Affects R1, R2][Technical] Gmail's compose DOM is unstable across Gmail
  redesigns; planning should pick a concrete strategy for hooking the Send
  click and mutating the outgoing body that minimizes ongoing maintenance
  (e.g., MutationObserver on a stable ancestor; intercepting the XHR; using a
  known community library like InboxSDK). Validate which approaches still
  work in 2026 Gmail.
- [Affects R12][Needs research] Gmail History API polling vs. push
  notifications via Pub/Sub. Polling every 1–2 minutes is well under free
  quota and avoids Pub/Sub setup; push gives lower latency. Verify the
  Netlify Scheduled Functions free tier supports a 1–2 minute cadence (or
  pick the highest acceptable interval it does support); pick polling vs
  push during planning based on cost/complexity.
- [Affects R6][Needs research] Confirm current Gmail image-proxy caching
  behavior for `Cache-Control: no-store` plus per-request cache-buster
  query strings. If caching still suppresses repeat opens, decide whether
  to live with it or use a redirect-based pixel (`/pixel/<token>` → 302 →
  `/img/<nonce>.gif`).
- [Affects R7, R9][Technical] Source for known proxy IP ranges (Google
  netblocks via `_cloud-netblocks.googleusercontent.com` and similar; Apple
  MPP relays; Microsoft Exchange Online ranges). Decide whether to hardcode
  CIDR lists, fetch on schedule, or rely on UA pattern matching as a
  fallback.
- [Affects R5, R10–R12][Technical] Concrete tag schema and dashboard
  filter semantics (single tag column with enum vs. boolean flags; default
  filter rule; how "show all" affects the open count).
- [Affects R20][Technical] DNS / TLS setup for the pixel custom domain on
  Netlify (apex vs. subdomain, automatic certificate).
- [Affects all][Technical] Manifest V3 service-worker lifetime constraints
  affect how the extension talks to the backend; planning should design
  message passing that survives service-worker restarts.

## Next Steps

→ `/ce-plan` for structured implementation planning
