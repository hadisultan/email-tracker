// Singleton Supabase browser client for the dashboard.
//
// Configured via Vite-bundled env vars set in `.env` (or Netlify build env):
//   VITE_SUPABASE_URL          — https://<project>.supabase.co
//   VITE_SUPABASE_ANON_KEY     — public anon key (RLS does the actual gating)
//
// We keep a single instance per page so the GoTrue auth state stays
// consistent across components (signin redirect, session refresh, etc).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase env not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY',
    );
  }
  cached = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return cached;
}

export async function getJwt(): Promise<string | null> {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
