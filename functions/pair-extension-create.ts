// POST /api/pair-extension-create
//
// Authenticated by the dashboard's Supabase JWT. Issues a short-lived
// pairing code that the user types into the Chrome extension to claim a
// service token (see pair-extension-claim.ts).
//
// Returns the 16-char base32 code (formatted XXXX-XXXX-XXXX-XXXX) ONCE.
// Only its SHA-256 hash is stored.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { generatePairingCode, isOwnerEmail, normalizePairingCode, requireUserJwt, sha256Hex } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';

const CODE_TTL_MS = 10 * 60_000;

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  const auth = await requireUserJwt(req);
  if (!auth.ok) return auth.response;

  if (!isOwnerEmail(auth.data.email)) {
    return respondError('not_authorized', 'email not in owner allowlist', 403);
  }

  const code = generatePairingCode();
  const codeHash = sha256Hex(normalizePairingCode(code));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const sb = serviceRoleClient();
  const { error } = await sb
    .from('pairing_codes')
    .insert({ code_hash: codeHash, user_id: auth.data.userId, expires_at: expiresAt });
  if (error) {
    console.error(JSON.stringify({ source: 'pair-extension-create', stage: 'insert', err: error.message }));
    return respondError('internal_error', 'failed to issue pairing code', 500);
  }

  return respondJson({ code, expires_at: expiresAt });
}

export default withCors(handler);

export const config = { path: '/api/pair-extension-create' };
