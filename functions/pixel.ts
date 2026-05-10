// /pixel/:token - public, unauthenticated open-tracking endpoint.
//
// Always returns 200 + a 1x1 transparent GIF, no matter what happens
// inside. Recording the hit is a side effect; failures must never
// break the recipient's email render.

import type { Context } from '@netlify/functions';

import { serviceRoleClient } from './lib/supabase.js';
import {
  TRANSPARENT_GIF,
  TRANSPARENT_GIF_HEADERS,
} from './lib/transparent-gif.js';
import { classifyHit, type RecentBeacon } from './lib/tag-classifier.js';
import {
  lookupProxyLabel,
  lookupProxyLabelFromUA,
} from './lib/proxy-cidrs.js';

const NOTIFY_DELAY_SECONDS = 90;
const BEACON_WINDOW_MS = 5 * 60_000;

interface MessageRow {
  id: string;
  user_id: string;
  gmail_thread_id: string | null;
  sent_at: string | null;
}

function pixelResponse(): Response {
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the body length
  // is exact and stable across node/edge runtimes. (Avoids the
  // ArrayBuffer | SharedArrayBuffer typing on Uint8Array#buffer.)
  const body = new Uint8Array(TRANSPARENT_GIF.byteLength);
  body.set(TRANSPARENT_GIF);
  return new Response(body, {
    status: 200,
    headers: TRANSPARENT_GIF_HEADERS,
  });
}

function logError(fields: Record<string, unknown>): void {
  // Structured single-line JSON so Netlify's log viewer can filter
  // by `source: 'pixel'`.
  console.error(JSON.stringify({ source: 'pixel', ...fields }));
}

function extractToken(url: URL): string | null {
  // The Netlify redirect rewrites /pixel/<token> -> the function URL
  // and preserves the path under `:splat`. We look at the trailing
  // path segment of the requested URL so the same code works in
  // local Netlify dev and in production.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1]!;
  if (!last || last === 'pixel') return null;
  return last;
}

export default async function pixelHandler(
  req: Request,
  context: Context,
): Promise<Response> {
  const url = new URL(req.url);
  const token = extractToken(url);

  if (!token) {
    return pixelResponse();
  }

  const ua = req.headers.get('user-agent') ?? '';
  const ip = context.ip ?? null;
  const geo = context.geo ?? null;

  try {
    const sb = serviceRoleClient();

    const { data: messageRow, error: msgErr } = await sb
      .from('messages')
      .select('id, user_id, gmail_thread_id, sent_at')
      .eq('token', token)
      .maybeSingle<MessageRow>();

    if (msgErr) {
      logError({ token, stage: 'lookup', err: msgErr.message });
      return pixelResponse();
    }
    if (!messageRow) {
      // Unknown token: respond with the GIF, do not insert. No
      // information leak (response is identical for known tokens) and
      // no log noise (this is the common case for crawlers and old
      // emails).
      return pixelResponse();
    }

    const hitAt = new Date();
    const sentAt = messageRow.sent_at ? new Date(messageRow.sent_at) : null;

    let recentBeacons: RecentBeacon[] = [];
    if (messageRow.gmail_thread_id) {
      const beaconCutoff = new Date(hitAt.getTime() - BEACON_WINDOW_MS);
      const { data, error } = await sb
        .from('self_view_beacons')
        .select('gmail_thread_id, received_at')
        .eq('user_id', messageRow.user_id)
        .eq('gmail_thread_id', messageRow.gmail_thread_id)
        .gte('received_at', beaconCutoff.toISOString());
      if (error) {
        logError({ token, stage: 'beacons', err: error.message });
      } else if (data) {
        recentBeacons = data.map((row) => ({
          gmail_thread_id: row.gmail_thread_id as string | null,
          received_at: new Date(row.received_at as string),
        }));
      }
    }

    const proxyLabel =
      lookupProxyLabel(ip) ?? lookupProxyLabelFromUA(ua) ?? null;

    const tag = classifyHit({
      sentAt,
      hitAt,
      threadId: messageRow.gmail_thread_id,
      recentBeacons,
      proxyLabel,
      ua,
    });

    const notify_after =
      tag === 'none'
        ? new Date(hitAt.getTime() + NOTIFY_DELAY_SECONDS * 1000).toISOString()
        : null;

    const insertResult = await sb.from('pixel_hits').insert({
      message_id: messageRow.id,
      hit_at: hitAt.toISOString(),
      ip,
      user_agent: ua,
      geo,
      proxy_label: proxyLabel,
      tag,
      notify_after,
    });

    if (insertResult.error) {
      logError({ token, stage: 'insert', err: insertResult.error.message });
    }
  } catch (err) {
    logError({
      token,
      stage: 'unhandled',
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return pixelResponse();
}

// No `export const config` — leaving the function on its default
// auto-mount at `/.netlify/functions/pixel`. The public `/pixel/<token>`
// path is wired by a redirect in `netlify.toml`. We tried two V2
// `config.path` variants ('/pixel/*' and '/pixel/:token') and neither
// registered at deploy time on this account; the redirect-to-legacy
// approach is the path that actually works in production. The token is
// still parsed from the URL path via `extractToken`, which works
// identically whether the function was reached via the redirect (which
// preserves the `:splat` segment) or via a direct legacy URL hit.
