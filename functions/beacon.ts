// POST /api/beacon
//
// Service-token gated. The Chrome extension posts here when Gmail renders
// one of the user's own threads — those views must be excluded from
// "recipient opened" notifications.
//
// Spoof-resistance: a leaked service token cannot suppress notifications
// for arbitrary thread IDs. We require the thread to belong to one of the
// caller's own messages; foreign thread IDs are silently dropped.
// Symmetric 204 (accept and drop) means the caller can't probe whether a
// thread exists, which is fine because both outcomes are valid.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requireServiceToken } from './lib/auth.js';
import { respondError, respondNoContent } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';

interface Body {
  gmail_thread_id: string;
}

function parseBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.gmail_thread_id !== 'string' || o.gmail_thread_id.length === 0) return null;
  return { gmail_thread_id: o.gmail_thread_id };
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
    return respondError('bad_request', 'expected { gmail_thread_id }', 400);
  }

  const sb = serviceRoleClient();

  // Ownership check: the thread must appear in one of the caller's
  // own messages. We use HEAD + count to avoid pulling rows we don't read.
  const { count, error: ownErr } = await sb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', auth.data.userId)
    .eq('gmail_thread_id', body.gmail_thread_id)
    .limit(1);
  if (ownErr) {
    console.error(JSON.stringify({ source: 'beacon', stage: 'ownership', err: ownErr.message }));
    return respondError('internal_error', 'failed to verify thread', 500);
  }

  if (!count || count === 0) {
    console.warn(
      JSON.stringify({
        source: 'beacon',
        stage: 'foreign-thread',
        user_id: auth.data.userId,
        thread_id: body.gmail_thread_id,
      }),
    );
    return respondNoContent();
  }

  const { error: insErr } = await sb.from('self_view_beacons').insert({
    user_id: auth.data.userId,
    gmail_thread_id: body.gmail_thread_id,
  });
  if (insErr) {
    console.error(JSON.stringify({ source: 'beacon', stage: 'insert', err: insErr.message }));
    return respondError('internal_error', 'failed to record beacon', 500);
  }

  return respondNoContent();
}

export default withCors(handler);

export const config = { path: '/api/beacon' };
