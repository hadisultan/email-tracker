// POST /api/mint
//
// Service-token gated. Records a freshly-composed Gmail message and returns
// the tracking pixel URL the extension will splice into the HTML body.
//
// Network-retry-safe via mandatory `Idempotency-Key: <uuid>` header. The
// header value is stored on the row as `client_send_id` (UNIQUE). On a
// duplicate POST (UNIQUE violation, Postgres SQLSTATE 23505) the original
// row's token is returned, so a retried request always sees the same
// pixel URL.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requireServiceToken } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { serviceRoleClient } from './lib/supabase.js';
import { mintTrackingToken } from './lib/token.js';

const MAX_SUBJECT_LEN = 998;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  subject: string;
  recipients: string[];
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  sent_at: string;
}

function parseBody(raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.subject !== 'string') return null;
  if (!Array.isArray(o.recipients) || o.recipients.length === 0) return null;
  if (!o.recipients.every((r): r is string => typeof r === 'string')) return null;
  if (typeof o.sent_at !== 'string' || Number.isNaN(Date.parse(o.sent_at))) return null;
  const gtid = o.gmail_thread_id;
  const gmid = o.gmail_message_id;
  if (gtid !== undefined && gtid !== null && typeof gtid !== 'string') return null;
  if (gmid !== undefined && gmid !== null && typeof gmid !== 'string') return null;
  return {
    subject: o.subject.length > MAX_SUBJECT_LEN ? o.subject.slice(0, MAX_SUBJECT_LEN) : o.subject,
    recipients: o.recipients,
    gmail_thread_id: typeof gtid === 'string' ? gtid : null,
    gmail_message_id: typeof gmid === 'string' ? gmid : null,
    sent_at: o.sent_at,
  };
}

function pixelUrlFor(token: string): string {
  const base = process.env.SITE_URL ?? '';
  return `${base.replace(/\/$/, '')}/pixel/${token}`;
}

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  const auth = await requireServiceToken(req);
  if (!auth.ok) return auth.response;

  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return respondError('idempotency_required', 'Idempotency-Key header required', 400);
  }
  if (!UUID_RE.test(idempotencyKey)) {
    return respondError('bad_request', 'Idempotency-Key must be a UUID', 400);
  }

  let body: Body | null;
  try {
    body = parseBody(await req.json());
  } catch {
    return respondError('bad_request', 'invalid JSON body', 400);
  }
  if (!body) {
    return respondError(
      'bad_request',
      'expected { subject, recipients[], sent_at, gmail_thread_id?, gmail_message_id? }',
      400,
    );
  }

  const token = mintTrackingToken();
  const sb = serviceRoleClient();

  const { error: insErr } = await sb.from('messages').insert({
    user_id: auth.data.userId,
    token,
    client_send_id: idempotencyKey,
    subject: body.subject,
    recipients: body.recipients,
    gmail_thread_id: body.gmail_thread_id,
    gmail_message_id: body.gmail_message_id,
    sent_at: body.sent_at,
  });

  if (insErr) {
    if (insErr.code === '23505') {
      // Duplicate Idempotency-Key -> return the original row's token.
      const { data: existing, error: selErr } = await sb
        .from('messages')
        .select('token')
        .eq('user_id', auth.data.userId)
        .eq('client_send_id', idempotencyKey)
        .maybeSingle();
      if (selErr || !existing || typeof existing.token !== 'string') {
        console.error(
          JSON.stringify({ source: 'mint', stage: 'select-existing', err: selErr?.message }),
        );
        return respondError('internal_error', 'failed to recover idempotent row', 500);
      }
      return respondJson({ token: existing.token, pixel_url: pixelUrlFor(existing.token) });
    }
    console.error(JSON.stringify({ source: 'mint', stage: 'insert', err: insErr.message }));
    return respondError('internal_error', 'failed to record message', 500);
  }

  return respondJson({ token, pixel_url: pixelUrlFor(token) });
}

export default withCors(handler);

export const config = { path: '/api/mint' };
