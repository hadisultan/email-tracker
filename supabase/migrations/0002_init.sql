-- 0002_init.sql
--
-- Tables for the personal email tracker. Designed for a single owner
-- but every user-scoped row carries user_id so the schema is ready for
-- multi-user evolution.
--
-- Run order: extensions -> init -> rls -> views -> seed.
-- See db/README.md.

-- Owner identity. NO foreign key to auth.users on purpose: the seed
-- script creates the row before any Supabase Auth row exists, and U4
-- (oauth-finalize) sets public.users.id = auth.users.id explicitly.
CREATE TABLE public.users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    google_sub  text UNIQUE,
    email       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Server-only Gmail OAuth credentials. One row per user.
-- Refresh-token preservation on upsert is handled by callers via:
--   COALESCE(EXCLUDED.refresh_token, gmail_credentials.refresh_token)
CREATE TABLE public.gmail_credentials (
    user_id                  uuid PRIMARY KEY
                             REFERENCES public.users(id) ON DELETE CASCADE,
    refresh_token            text,
    access_token             text,
    access_token_expires_at  timestamptz,
    last_history_id          text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Bearer tokens minted for the Chrome extension. token_hash is the
-- sha256(token) so the raw bearer is never persisted.
CREATE TABLE public.service_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash    text UNIQUE,
    label         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    revoked_at    timestamptz
);

CREATE INDEX service_tokens_active_user_idx
    ON public.service_tokens (user_id)
    WHERE revoked_at IS NULL;

-- Short-lived dashboard -> extension pairing handshake. code_hash is
-- the sha256(code) so the raw code is never persisted.
CREATE TABLE public.pairing_codes (
    code_hash    text PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz
);

-- One row per minted tracking token. client_send_id backs the
-- Idempotency-Key header from /api/mint. last_notified_at powers the
-- per-(message, hour) push dedupe.
CREATE TABLE public.messages (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token             text UNIQUE,
    client_send_id    uuid NOT NULL UNIQUE,
    subject           text,
    recipients        text[],
    gmail_thread_id   text,
    gmail_message_id  text,
    sent_at           timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_notified_at  timestamptz
);

CREATE INDEX messages_user_sent_at_idx
    ON public.messages (user_id, sent_at DESC);

CREATE INDEX messages_gmail_thread_idx
    ON public.messages (gmail_thread_id);

-- One row per pixel load. tag is enum-by-convention only (no CHECK
-- constraint by design): 'none' | 'likely_prefetch' |
-- 'self_view_desktop' | 'self_view_mobile'. Function code is the
-- source of truth.
--
-- notify_after = hit_at + interval '90 seconds' for tag='none' rows
-- (NULL otherwise); notified_at is stamped when the push succeeds.
-- No notify_attempts column - retry is intentionally one-shot.
CREATE TABLE public.pixel_hits (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id    uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    hit_at        timestamptz NOT NULL DEFAULT now(),
    ip            inet,
    user_agent    text,
    geo           jsonb,
    proxy_label   text,
    tag           text NOT NULL DEFAULT 'none',
    notify_after  timestamptz,
    notified_at   timestamptz
);

CREATE INDEX pixel_hits_message_hit_at_idx
    ON public.pixel_hits (message_id, hit_at DESC);

CREATE INDEX pixel_hits_tag_hit_at_idx
    ON public.pixel_hits (tag, hit_at DESC);

-- Partial index that drives the poller drain query. Stays slim by
-- excluding 'tagged' and 'notified' rows.
CREATE INDEX pixel_hits_drain_idx
    ON public.pixel_hits (notify_after)
    WHERE tag = 'none' AND notified_at IS NULL;

-- Self-view beacons posted by the extension when Gmail renders the
-- sender's own thread. Keyed by gmail_thread_id; received_at lets the
-- poller correlate against pixel hits within a short window.
CREATE TABLE public.self_view_beacons (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    gmail_thread_id  text,
    received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX self_view_beacons_thread_received_at_idx
    ON public.self_view_beacons (gmail_thread_id, received_at DESC);

-- Web-Push subscriptions. last_success_at powers the HealthBanner
-- "delivery path is alive" signal in system_health.
CREATE TABLE public.push_subscriptions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    endpoint          text UNIQUE,
    p256dh            text,
    auth              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_used_at      timestamptz,
    last_success_at   timestamptz
);

CREATE INDEX push_subscriptions_user_idx
    ON public.push_subscriptions (user_id);

-- Observability for the cron poller. Partial index supports the
-- "last successful poll" lookup used by system_health.
CREATE TABLE public.gmail_poll_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at               timestamptz NOT NULL DEFAULT now(),
    finished_at              timestamptz,
    ok                       bool,
    error                    text,
    history_ids_processed    int,
    drained_pushes           int
);

CREATE INDEX gmail_poll_runs_ok_finished_idx
    ON public.gmail_poll_runs (finished_at DESC)
    WHERE ok = true;
