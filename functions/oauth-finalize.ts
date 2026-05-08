// POST /api/oauth-finalize
//
// Called by the dashboard immediately after Supabase Google OAuth completes.
// Body: { provider_token, provider_refresh_token, expires_at } — the
// provider tokens that Supabase exposes via `session.provider_*`.
//
// Steps:
//   1. Verify the user's Supabase JWT.
//   2. Verify the email is in OWNER_EMAIL_ALLOWLIST.
//   3. Mirror auth.users.id into public.users (single-user-tool invariant:
//      public.users.id == auth.users.id).
//   4. Upsert public.gmail_credentials with COALESCE-on-refresh_token: when
//      Google omits the refresh token on re-sign-in we preserve the stored
//      value rather than overwriting it with NULL.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requireUserJwt, isOwnerEmail } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';

interface Body {
  provider_token: string;
  provider_refresh_token: string | null;
  expires_at: number;
}

function parseBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.provider_token !== 'string' || o.provider_token.length === 0) return null;
  if (typeof o.expires_at !== 'number' || !Number.isFinite(o.expires_at)) return null;
  const rt = o.provider_refresh_token;
  if (rt !== null && typeof rt !== 'string') return null;
  return {
    provider_token: o.provider_token,
    provider_refresh_token: rt ?? null,
    expires_at: o.expires_at,
  };
}

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  const auth = await requireUserJwt(req);
  if (!auth.ok) return auth.response;

  if (!isOwnerEmail(auth.data.email)) {
    return respondError('not_authorized', 'email not in owner allowlist', 403);
  }

  let body: Body | null;
  try {
    body = parseBody(await req.json());
  } catch {
    return respondError('bad_request', 'invalid JSON body', 400);
  }
  if (!body) {
    return respondError('bad_request', 'expected { provider_token, provider_refresh_token, expires_at }', 400);
  }

  const sb = serviceRoleClient();

  // Mirror auth.users → public.users so FKs resolve.
  const { error: userErr } = await sb
    .from('users')
    .upsert(
      { id: auth.data.userId, email: auth.data.email },
      { onConflict: 'id' },
    );
  if (userErr) {
    console.error(JSON.stringify({ source: 'oauth-finalize', stage: 'users-upsert', err: userErr.message }));
    return respondError('internal_error', 'failed to mirror user record', 500);
  }

  // Upsert gmail_credentials. Omitting refresh_token from the column list
  // when null leaves it unchanged on conflict — the supabase-js upsert
  // builds DO UPDATE SET only for the columns we provide, which is the
  // COALESCE behavior we want without raw SQL.
  const upsertRow: Record<string, unknown> = {
    user_id: auth.data.userId,
    access_token: body.provider_token,
    access_token_expires_at: new Date(body.expires_at * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (body.provider_refresh_token !== null) {
    upsertRow.refresh_token = body.provider_refresh_token;
  }

  const { error: credErr } = await sb
    .from('gmail_credentials')
    .upsert(upsertRow, { onConflict: 'user_id' });
  if (credErr) {
    console.error(JSON.stringify({ source: 'oauth-finalize', stage: 'cred-upsert', err: credErr.message }));
    return respondError('internal_error', 'failed to store gmail credentials', 500);
  }

  return respondJson({ ok: true });
}

export default withCors(handler);

export const config = { path: '/api/oauth-finalize' };
