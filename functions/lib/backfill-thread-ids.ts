// Backfill phase of the Gmail poller. Resolves
// `messages.gmail_thread_id` for fresh sends — the extension can't
// learn the thread_id at compose time, so the column is NULL until
// this phase populates it from Gmail.
//
// Wired into `gmail-poll.ts` immediately after OAuth refresh and
// before the history-list classification step. Failures are logged
// but do NOT abort the poll cycle: the history-list step can still
// classify already-backfilled messages, and the next tick will retry
// the failed backfill.
//
// API budget: at most one `messages.list` call + one `messages.get`
// call per NULL-thread message. Bounded by `MAX_CANDIDATES` so a
// pathological state can't issue hundreds of API calls per tick.

import type { Sql, TransactionSql } from 'postgres';
import {
  getMessageMetadata,
  listSentMessages,
  type SentMessageRef,
} from './gmail-api.js';
import {
  matchSentToMessages,
  type CandidateMessage,
  type SentMetadata,
} from './match-sent-to-messages.js';

// Maximum NULL-thread messages we'll examine in a single poll cycle.
// At <50 sends/day this is far above any reasonable backfill load —
// the cap exists to fence runaway bugs, not as a tuning parameter.
const MAX_CANDIDATES = 50;

// Window of `sent_at` we consider for backfill. Older sends are
// either already backfilled (success) or will never be (the user
// edited the subject post-send, or the row was minted in a test
// fixture, or Gmail evicted the message). The poller's other phases
// look at the last hour of pixel_hits, so a 24h backfill window is
// more than sufficient.
const BACKFILL_LOOKBACK = '24 hours';

// Bias the Gmail messages.list query toward freshness. Match the DB
// lookback so we never pull Gmail metadata we couldn't possibly use.
const GMAIL_NEWER_THAN = '1d';

export interface BackfillResult {
  // How many NULL-thread messages we considered.
  candidates: number;
  // How many we actually backfilled (subject + ±5min match found).
  backfilled: number;
}

export interface BackfillDeps {
  // Either a top-level postgres-js client or a transaction handle.
  // The poller currently calls this inside a transaction; tests can
  // pass a plain `sql` client directly.
  sql: Sql | TransactionSql;
  userId: string;
  accessToken: string;
}

export async function backfillThreadIds(
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const { sql, userId, accessToken } = deps;

  const candidateRows = await sql<
    Array<{ id: string; subject: string; sent_at: string }>
  >`
    SELECT id, subject, sent_at
    FROM public.messages
    WHERE user_id = ${userId}
      AND gmail_thread_id IS NULL
      AND sent_at > now() - interval '${sql.unsafe(BACKFILL_LOOKBACK)}'
    ORDER BY sent_at DESC
    LIMIT ${MAX_CANDIDATES}
  `;
  if (candidateRows.length === 0) {
    return { candidates: 0, backfilled: 0 };
  }

  const candidates: CandidateMessage[] = candidateRows.map((r) => ({
    id: r.id,
    subject: r.subject,
    sentAt: r.sent_at,
  }));

  let sentRefs: SentMessageRef[];
  try {
    sentRefs = await listSentMessages({
      accessToken,
      newerThan: GMAIL_NEWER_THAN,
      maxResults: 50,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        source: 'gmail-poll',
        stage: 'backfill-list',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return { candidates: candidates.length, backfilled: 0 };
  }
  if (sentRefs.length === 0) {
    return { candidates: candidates.length, backfilled: 0 };
  }

  const sentMetas: SentMetadata[] = [];
  for (const ref of sentRefs) {
    let meta;
    try {
      meta = await getMessageMetadata({
        accessToken,
        messageId: ref.id,
        headerNames: ['Subject'],
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          source: 'gmail-poll',
          stage: 'backfill-meta',
          gmail_message_id: ref.id,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }
    if (!meta) continue;
    const internalDateMs = Number(meta.internalDate);
    if (!Number.isFinite(internalDateMs)) continue;
    sentMetas.push({
      messageId: meta.id,
      threadId: meta.threadId,
      subject: meta.headers['subject'] ?? '',
      internalDateMs,
    });
  }

  const updates = matchSentToMessages(candidates, sentMetas);
  if (updates.length === 0) {
    return { candidates: candidates.length, backfilled: 0 };
  }

  // Apply updates one at a time. The WHERE clause guards against a
  // concurrent backfill or a pre-existing thread_id (defense in depth
  // for the case where the row was backfilled between our SELECT and
  // UPDATE).
  let backfilled = 0;
  for (const u of updates) {
    const result = await sql<{ id: string }[]>`
      UPDATE public.messages
      SET gmail_thread_id = ${u.gmailThreadId},
          gmail_message_id = ${u.gmailMessageId}
      WHERE id = ${u.candidateId} AND gmail_thread_id IS NULL
      RETURNING id
    `;
    if (result.length > 0) backfilled++;
  }

  return { candidates: candidates.length, backfilled };
}

export const _internals = {
  MAX_CANDIDATES,
  BACKFILL_LOOKBACK,
  GMAIL_NEWER_THAN,
};
