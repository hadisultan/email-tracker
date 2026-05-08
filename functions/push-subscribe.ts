// POST /api/push-subscribe
//
// Stores (or refreshes) the caller's Web-Push subscription. Keyed by
// `endpoint` (UNIQUE) — if the browser re-subscribes after a VAPID
// rotation or push-permission change, the keys (`p256dh`, `auth`) MUST
// be overwritten, otherwise every push fails silently with stale crypto.
// We always rewrite p256dh, auth, user_id, and last_used_at on conflict.
//
// Dual-auth: accepts EITHER an extension service token (prefixed `et_`)
// OR a dashboard Supabase JWT. Service tokens are tied 1:1 to a user
// row at creation time; JWTs additionally pass through the owner
// allowlist check so a hostile non-owner JWT can't add a subscription
// even on the single-user instance.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { isOwnerEmail, requireServiceToken, requireUserJwt } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';

interface Body {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function parseBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.endpoint !== 'string' || o.endpoint.length === 0) return null;
  const keys = o.keys;
  if (!keys || typeof keys !== 'object') return null;
  const k = keys as Record<string, unknown>;
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  if (k.p256dh.length === 0 || k.auth.length === 0) return null;
  return { endpoint: o.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  // Pick auth path by token prefix. Extension service tokens are
  // minted with the `et_` prefix (see auth.ts:generateServiceToken);
  // anything else is treated as a Supabase JWT. An empty/missing
  // bearer is rejected here so both auth paths produce a consistent
  // 401 instead of leaking which path was attempted. The prefix check
  // is case-insensitive to match the case-insensitive Bearer-header
  // regex on the line above — otherwise a hypothetical `ET_…` token
  // would silently route to the JWT path.
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  if (bearer.length === 0) {
    return respondError('invalid_token', 'missing Authorization bearer token', 401);
  }
  let userId: string;
  if (bearer.toLowerCase().startsWith('et_')) {
    const auth = await requireServiceToken(req);
    if (!auth.ok) return auth.response;
    userId = auth.data.userId;
  } else {
    const auth = await requireUserJwt(req);
    if (!auth.ok) return auth.response;
    if (!isOwnerEmail(auth.data.email)) {
      return respondError('not_authorized', 'email not in owner allowlist', 403);
    }
    userId = auth.data.userId;
  }

  let body: Body | null;
  try {
    body = parseBody(await req.json());
  } catch {
    return respondError('bad_request', 'invalid JSON body', 400);
  }
  if (!body) {
    return respondError('bad_request', 'expected { endpoint, keys: { p256dh, auth } }', 400);
  }

  const sb = serviceRoleClient();
  const nowIso = new Date().toISOString();

  const { error } = await sb
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        last_used_at: nowIso,
      },
      { onConflict: 'endpoint' },
    );
  if (error) {
    console.error(JSON.stringify({ source: 'push-subscribe', stage: 'upsert', err: error.message }));
    return respondError('internal_error', 'failed to store push subscription', 500);
  }

  return respondJson({ ok: true });
}

export default withCors(handler);

export const config = { path: '/api/push-subscribe' };
