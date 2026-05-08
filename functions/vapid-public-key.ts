// GET /api/vapid-public-key
//
// Tiny JWT-gated function that exposes the server's VAPID public key so
// the dashboard can call `pushManager.subscribe({ applicationServerKey })`
// without hard-coding the key in the bundled JS. The corresponding
// private key never leaves the server.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requireUserJwt } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'GET') {
    return respondError('method_not_allowed', 'GET required', 405);
  }

  const auth = await requireUserJwt(req);
  if (!auth.ok) return auth.response;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return respondError('internal_error', 'VAPID_PUBLIC_KEY not configured', 500);
  }

  return respondJson({ publicKey });
}

export default withCors(handler);

export const config = { path: '/api/vapid-public-key' };
