-- 0003_rls.sql
--
-- Row-level security. Two policy classes:
--
-- 1. User-data tables (messages, pixel_hits, self_view_beacons,
--    push_subscriptions): authenticated users can SELECT their own
--    rows. INSERT/UPDATE/DELETE go through service-role only (the
--    Netlify Functions). No policy is needed for service-role: the
--    Supabase service-role role has BYPASSRLS at the Postgres level.
--
-- 2. Server-only tables (users, gmail_credentials, service_tokens,
--    pairing_codes, gmail_poll_runs): RLS enabled with no policies,
--    which denies all access to anon and authenticated. service-role
--    still works via BYPASSRLS. system_health (0004_views.sql) is the
--    authenticated-readable surface for select fields from these
--    tables.

-- 1) User-data tables: own-row SELECT, no other policies.
ALTER TABLE public.messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pixel_hits            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.self_view_beacons     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions    ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_owner_select
    ON public.messages
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- pixel_hits has no user_id column directly; ownership is via
-- message_id -> messages.user_id.
CREATE POLICY pixel_hits_owner_select
    ON public.pixel_hits
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.messages m
            WHERE m.id = pixel_hits.message_id
              AND m.user_id = auth.uid()
        )
    );

CREATE POLICY self_view_beacons_owner_select
    ON public.self_view_beacons
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY push_subscriptions_owner_select
    ON public.push_subscriptions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 2) Server-only tables: enable RLS, add no policies -> deny-all.
ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_credentials   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_tokens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pairing_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gmail_poll_runs     ENABLE ROW LEVEL SECURITY;
