// Thin wrapper around the `web-push` library.
//
// This module owns two concerns:
//
//   1. VAPID configuration. `web-push` is a singleton — `setVapidDetails`
//      mutates module-level state — so we cache the "we already configured
//      VAPID" flag here and skip redundant calls.
//
//   2. Result classification. `web-push` throws `WebPushError` with a
//      `statusCode` property. We translate those into a small
//      `{ ok, transient, statusCode }` shape so callers don't need to
//      care about the underlying library's error taxonomy:
//        - 2xx                                   → ok=true
//        - 404 / 410 (subscription gone)         → ok=false, transient=false
//                                                  AND we DELETE the row
//                                                  from `push_subscriptions`
//        - other 4xx                             → ok=false, transient=false
//        - network errors / 5xx / no statusCode  → ok=false, transient=true
//
// `notify.ts` uses `transient` to decide whether to leave
// `pixel_hits.notified_at = NULL` (so the next cron drain retries) or stamp
// it (so the hit is considered handled — successfully or permanently
// failed).

import webpush from 'web-push';
import { serviceRoleClient } from './supabase.js';

let vapidConfigured = false;

function ensureVapidConfigured(): void {
  if (vapidConfigured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT;
  if (!publicKey || !privateKey || !contact) {
    throw new Error(
      'VAPID env not configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_CONTACT)',
    );
  }
  webpush.setVapidDetails(contact, publicKey, privateKey);
  vapidConfigured = true;
}

// Tests reset the cached flag so they can re-read env between cases.
export function _resetVapidConfiguredForTests(): void {
  vapidConfigured = false;
}

export interface PushPayload {
  title: string;
  body: string;
  icon: string;
  data: {
    messageId: string;
    dashboardUrl: string;
  };
}

export interface PushSub {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  transient: boolean;
  statusCode?: number;
}

interface WebPushErrorLike {
  statusCode?: number;
  body?: string;
  message?: string;
}

function isWebPushError(err: unknown): err is WebPushErrorLike {
  return typeof err === 'object' && err !== null && 'statusCode' in err;
}

async function deleteStaleSubscription(sub: PushSub): Promise<void> {
  const sb = serviceRoleClient();
  const { error } = await sb.from('push_subscriptions').delete().eq('id', sub.id);
  if (error) {
    console.error(
      JSON.stringify({
        source: 'web_push',
        stage: 'delete_stale',
        endpoint: sub.endpoint,
        err: error.message,
      }),
    );
  }
}

export async function sendNotification(
  sub: PushSub,
  payload: PushPayload,
): Promise<SendResult> {
  ensureVapidConfigured();

  const subscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };

  try {
    const res = await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true, transient: false, statusCode: res.statusCode };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const statusCode = isWebPushError(err) ? err.statusCode : undefined;

    if (statusCode === 404 || statusCode === 410) {
      await deleteStaleSubscription(sub);
      return { ok: false, transient: false, statusCode };
    }

    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      console.error(
        JSON.stringify({
          source: 'web_push',
          stage: 'non_transient',
          endpoint: sub.endpoint,
          statusCode,
          err: msg,
        }),
      );
      return { ok: false, transient: false, statusCode };
    }

    // Network errors, 5xx, missing statusCode — all treated as transient.
    console.warn(
      JSON.stringify({
        source: 'web_push',
        stage: 'transient',
        endpoint: sub.endpoint,
        statusCode,
        err: msg,
      }),
    );
    return { ok: false, transient: true, statusCode };
  }
}
