// Service-role Supabase client factory.
//
// Used by every Netlify function that needs to write to the database
// (mint, beacon, push-subscribe, oauth-finalize, pixel). Service-role
// bypasses RLS via Postgres-level BYPASSRLS, so callers do not need
// to think about policies.
//
// The poller (Unit 7) uses `postgres` (porsager) directly because it
// needs an explicit transaction for advisory-lock semantics; this
// factory is for everything else.
//
// `authClient()` returns the same service-role client by default, but
// tests can override it via `_setAuthClientForTests` to avoid hitting
// the real Supabase Auth service.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;
let authOverride: SupabaseClient | null = null;

export function serviceRoleClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

  cached = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: { schema: 'public' },
    global: {
      headers: { 'X-Client-Info': 'email-tracker-functions/0.1' },
    },
  });
  return cached;
}

// The auth client is the one used by `requireUserJwt` to call
// `auth.getUser(jwt)`. In production it's the same service-role client
// (the call works for any apikey). Tests override this to a stub.
export function authClient(): SupabaseClient {
  if (authOverride) return authOverride;
  return serviceRoleClient();
}

// Test-only: reset the cached client. Tests that mutate env vars (e.g.
// to test missing-config errors) call this between cases.
export function _resetServiceRoleClientForTests(): void {
  cached = null;
}

// Test-only: install a stub auth client (must satisfy the SupabaseClient
// shape used by requireUserJwt — primarily `auth.getUser(jwt)`).
export function _setAuthClientForTests(client: SupabaseClient | null): void {
  authOverride = client;
}
