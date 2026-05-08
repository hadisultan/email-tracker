-- 0004_views.sql
--
-- system_health (R22): exactly four signals that the dashboard's
-- HealthBanner consumes. One row per authenticated user.
--
-- DEVIATION from plan (documented in db/README.md): the plan called
-- for SECURITY INVOKER on this view, but that is incompatible with
-- the deny-all RLS on the underlying tables (gmail_credentials,
-- gmail_poll_runs) - the view would return NULL for oauth_expiry and
-- last_poll_success_at for every authenticated user, defeating the
-- signal. SECURITY DEFINER plus an explicit WHERE auth.uid() = ...
-- filter is the standard Postgres pattern and produces the same
-- security property the plan was reaching for: only the caller's own
-- row is visible, and anon (auth.uid() IS NULL) sees zero rows.
--
-- The view is owned by the postgres role (DEFINER), but only exposes
-- four scalar signals - never raw refresh_token / access_token. We
-- additionally GRANT SELECT to authenticated only, NOT to anon.

CREATE OR REPLACE VIEW public.system_health
WITH (security_invoker = false) AS
SELECT
    u.id AS user_id,
    (SELECT MAX(ph.hit_at)
       FROM public.pixel_hits ph
       JOIN public.messages m ON m.id = ph.message_id
      WHERE m.user_id = u.id)                       AS last_pixel_hit_at,
    (SELECT MAX(gpr.finished_at)
       FROM public.gmail_poll_runs gpr
      WHERE gpr.ok = true)                          AS last_poll_success_at,
    (SELECT gc.access_token_expires_at
       FROM public.gmail_credentials gc
      WHERE gc.user_id = u.id)                      AS oauth_expiry,
    (SELECT MAX(ps.last_success_at)
       FROM public.push_subscriptions ps
      WHERE ps.user_id = u.id)                      AS last_push_success_at
FROM public.users u
WHERE u.id = auth.uid();

REVOKE ALL ON public.system_health FROM PUBLIC;
GRANT SELECT ON public.system_health TO authenticated;
