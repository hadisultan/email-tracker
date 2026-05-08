-- db/seed.sql
--
-- Single owner row. Idempotent: re-running is a no-op via
-- ON CONFLICT DO NOTHING. RLS is enabled on public.users so this must
-- be loaded under a role that bypasses RLS (postgres superuser or
-- service-role). Run order: extensions -> init -> rls -> views -> seed.
--
-- The deterministic UUID makes test fixtures stable. U4
-- (oauth-finalize) overwrites google_sub and email when the owner
-- completes the Google sign-in flow.

INSERT INTO public.users (id, email)
VALUES ('00000000-0000-0000-0000-000000000001', 'owner@local.test')
ON CONFLICT (id) DO NOTHING;
