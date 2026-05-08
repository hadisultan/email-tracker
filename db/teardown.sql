-- db/teardown.sql — idempotent DROP for every app-owned object.
--
-- Used during pre-release iteration to wipe the cloud Supabase project before
-- re-applying migrations. Idempotent: safe to run repeatedly even when the
-- objects don't yet exist (Unit 1 commits this script before Unit 2 creates
-- the tables it drops).
--
-- After Unit 9 verification, migrations become append-only and this script
-- should be retired (or kept as a documented "nuke" option for local dev).

BEGIN;

-- Views first (they depend on tables).
DROP VIEW IF EXISTS public.system_health CASCADE;

-- App tables (declared in U2 onwards). Order does not matter because of
-- CASCADE, but we list them in roughly dependency-first-deleted order for
-- readability.
DROP TABLE IF EXISTS public.pixel_hits CASCADE;
DROP TABLE IF EXISTS public.messages CASCADE;
DROP TABLE IF EXISTS public.push_subscriptions CASCADE;
DROP TABLE IF EXISTS public.gmail_credentials CASCADE;
DROP TABLE IF EXISTS public.service_tokens CASCADE;
DROP TABLE IF EXISTS public.pairing_codes CASCADE;
DROP TABLE IF EXISTS public.gmail_poll_runs CASCADE;

COMMIT;
