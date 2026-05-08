// POST /api/pair-extension-claim
//
// Unauthenticated. The Chrome extension posts a pairing code (typed by the
// user) and receives a fresh service token. Token cleartext is returned
// once; only the SHA-256 hash is stored.
//
// Single-use semantics are enforced atomically:
//   UPDATE pairing_codes
//   SET    consumed_at = now()
//   WHERE  code_hash = $1
//     AND  consumed_at IS NULL
//     AND  expires_at > now()
//   RETURNING user_id;
// If zero rows return, a follow-up SELECT distinguishes invalid / expired
// / already-consumed and surfaces the matching error code.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { generateServiceToken, normalizePairingCode, sha256Hex } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';

interface Body {
  code: string;
  label?: string | null;
}

function parseBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.code !== 'string' || o.code.length === 0) return null;
  const label = o.label;
  if (label !== undefined && label !== null && typeof label !== 'string') return null;
  return { code: o.code, label: typeof label === 'string' ? label : null };
}

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  let body: Body | null;
  try {
    body = parseBody(await req.json());
  } catch {
    return respondError('bad_request', 'invalid JSON body', 400);
  }
  if (!body) {
    return respondError('bad_request', 'expected { code }', 400);
  }

  const codeHash = sha256Hex(normalizePairingCode(body.code));
  const sb = serviceRoleClient();

  const nowIso = new Date().toISOString();

  // Atomic single-use claim. Update returns rows when the code matches,
  // is unconsumed, and unexpired.
  const { data: claimed, error: claimErr } = await sb
    .from('pairing_codes')
    .update({ consumed_at: nowIso })
    .eq('code_hash', codeHash)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('user_id');
  if (claimErr) {
    console.error(JSON.stringify({ source: 'pair-extension-claim', stage: 'claim', err: claimErr.message }));
    return respondError('internal_error', 'failed to claim pairing code', 500);
  }

  if (!claimed || claimed.length === 0) {
    // Disambiguate: read the existing row to surface a precise error.
    const { data: existing } = await sb
      .from('pairing_codes')
      .select('consumed_at, expires_at')
      .eq('code_hash', codeHash)
      .maybeSingle();
    if (!existing) {
      return respondError('code_invalid', 'pairing code not recognized', 400);
    }
    if (existing.consumed_at !== null) {
      return respondError('code_consumed', 'pairing code already used', 410);
    }
    return respondError('code_expired', 'pairing code expired', 410);
  }

  const userId = (claimed[0] as { user_id: string }).user_id;

  const token = generateServiceToken();
  const tokenHash = sha256Hex(token);

  const { error: insErr } = await sb
    .from('service_tokens')
    .insert({ user_id: userId, token_hash: tokenHash, label: body.label ?? null });
  if (insErr) {
    console.error(JSON.stringify({ source: 'pair-extension-claim', stage: 'insert-token', err: insErr.message }));
    return respondError('internal_error', 'failed to issue service token', 500);
  }

  return respondJson({ token });
}

export default withCors(handler);

export const config = { path: '/api/pair-extension-claim' };
