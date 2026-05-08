// POST /api/push-subscribe
//
// Service-token gated. Stores (or refreshes) the caller's Web-Push
// subscription. Keyed by `endpoint` (UNIQUE) — if the browser re-subscribes
// after a VAPID rotation or push-permission change, the keys (`p256dh`,
// `auth`) MUST be overwritten, otherwise every push fails silently with
// stale crypto. We always rewrite p256dh, auth, user_id, and last_used_at
// on conflict.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requireServiceToken } from './lib/auth.js';
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

  const auth = await requireServiceToken(req);
  if (!auth.ok) return auth.response;

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
        user_id: auth.data.userId,
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
