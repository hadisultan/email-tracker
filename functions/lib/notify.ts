// Push composition + delivery for a single ready `pixel_hits` row.
//
// Called by the gmail-poll drain step (Unit 7 step 10) for every hit
// whose `notify_after` has elapsed and whose `tag` is still `'none'`.
//
// Atomicity boundary is `messages.last_notified_at`: a conditional
// UPDATE establishes that THIS poll cycle is the one allowed to send a
// push for this message in this hour. If the UPDATE returns zero rows
// (the message was already notified within the current hour), we
// short-circuit: stamp `pixel_hits.notified_at` so the drain index
// doesn't keep returning the same hit, and report 0 pushes sent.
//
// Failure model is "one attempt per cron tick" — there is no retry
// budget and no notify_attempts column. The drain naturally re-picks
// hits whose `notified_at` is still NULL on the next tick. Per-hour
// dedupe via `last_notified_at` keeps that re-pick from spamming the
// recipient.

import type { Sql } from 'postgres';
import {
  sendNotification,
  type PushPayload,
  type PushSub,
  type SendResult,
} from './push.js';

const ICON_PATH = '/icon-192.png';

export interface SendPushesResult {
  pushes_sent: number;
  deduped: boolean;
  subscription_count: number;
}

interface MessageRow {
  id: string;
  user_id: string;
  subject: string | null;
  recipients: string[] | string | null;
}

// Exported for unit testing. The string form arises only when the
// postgres-js client cannot parse text[] (e.g. type catalog missing).
export function recipientLabel(recipients: string[] | string | null): string {
  // Belt-and-suspenders: if the underlying postgres-js client wasn't
  // able to parse `text[]` (e.g. because its type catalog wasn't
  // fetched), `recipients` arrives as the raw wire form `'{a,b,c}'`.
  // We previously hit this in production and shipped a notification
  // body of "21 recipients" because we read string `.length`. Now we
  // defensively re-parse on the call site so a future regression in
  // type handling doesn't silently corrupt notification bodies.
  let arr: string[];
  if (recipients == null) {
    arr = [];
  } else if (Array.isArray(recipients)) {
    arr = recipients;
  } else if (typeof recipients === 'string') {
    const trimmed = recipients.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1);
      arr = inner.length === 0 ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
    } else {
      arr = trimmed.length === 0 ? [] : [trimmed];
    }
  } else {
    arr = [];
  }
  if (arr.length === 0) return '(no recipients)';
  if (arr.length === 1) return arr[0]!;
  return `${arr.length} recipients`;
}

function composePayload(msg: MessageRow): PushPayload {
  const subject = msg.subject && msg.subject.length > 0 ? msg.subject : '(no subject)';
  return {
    title: subject,
    body: `${recipientLabel(msg.recipients)} — Opened just now`,
    icon: ICON_PATH,
    data: {
      messageId: msg.id,
      dashboardUrl: `/messages/${msg.id}`,
    },
  };
}

export async function sendPushesForHit(
  sql: Sql,
  hitId: string,
): Promise<SendPushesResult> {
  // Find the hit's owning message. If the hit vanished between drain
  // selection and now, treat as a no-op.
  const hits = await sql<{ message_id: string }[]>`
    SELECT message_id FROM public.pixel_hits WHERE id = ${hitId}
  `;
  if (hits.length === 0) {
    return { pushes_sent: 0, deduped: false, subscription_count: 0 };
  }
  const messageId = hits[0]!.message_id;

  // Per-(message, hour) dedupe gate. The conditional UPDATE returns zero
  // rows when another notification already stamped this message within
  // the current hour. Truncating to the hour boundary (rather than
  // last_notified_at + 1h) ensures a strict "at most one push per
  // wall-clock hour" semantic.
  const dedupe = await sql<MessageRow[]>`
    UPDATE public.messages
    SET last_notified_at = now()
    WHERE id = ${messageId}
      AND (
        last_notified_at IS NULL
        OR last_notified_at < date_trunc('hour', now())
      )
    RETURNING id, user_id, subject, recipients
  `;
  if (dedupe.length === 0) {
    // Already notified this hour. Stamp the hit so the drain doesn't
    // keep re-selecting it; 0 pushes sent.
    await sql`
      UPDATE public.pixel_hits SET notified_at = now() WHERE id = ${hitId}
    `;
    return { pushes_sent: 0, deduped: true, subscription_count: 0 };
  }

  const msg = dedupe[0]!;
  const payload = composePayload(msg);

  const subs = await sql<PushSub[]>`
    SELECT id, endpoint, p256dh, auth
    FROM public.push_subscriptions
    WHERE user_id = ${msg.user_id}
  `;

  let successCount = 0;
  let transientCount = 0;
  for (const sub of subs) {
    let result: SendResult;
    try {
      result = await sendNotification(sub, payload);
    } catch (err) {
      // Defensive: any uncaught error from the wrapper is treated as
      // transient so the next cron tick can retry.
      console.warn(
        JSON.stringify({
          source: 'notify',
          stage: 'send_unhandled',
          endpoint: sub.endpoint,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      transientCount++;
      continue;
    }
    if (result.ok) {
      successCount++;
      await sql`
        UPDATE public.push_subscriptions
        SET last_success_at = now()
        WHERE id = ${sub.id}
      `;
    } else if (result.transient) {
      transientCount++;
    }
  }

  // Stamp `notified_at` UNLESS the only outcomes were transient errors,
  // in which case leave it NULL so the next cron drain retries. Cases
  // that stamp:
  //   - 0 subs (no one to notify; don't keep retrying)
  //   - >=1 success
  //   - all errors were non-transient (404/410/4xx — never recoverable)
  const shouldStamp = subs.length === 0 || successCount > 0 || transientCount === 0;
  if (shouldStamp) {
    await sql`
      UPDATE public.pixel_hits SET notified_at = now() WHERE id = ${hitId}
    `;
  }

  return {
    pushes_sent: successCount,
    deduped: false,
    subscription_count: subs.length,
  };
}
