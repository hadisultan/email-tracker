// POST /api/gmail-poll
//
// Periodically classifies mobile/other-device self-opens by comparing
// Gmail's `users.history.list` (UNREAD-removed events) against recent
// `pixel_hits`. Driven by cron-job.org every 5 minutes — see
// `docs/cron-job.org-setup.md`.
//
// HMAC-only auth: there is no JWT path. Manual triggering is via curl
// with an X-Signature header derived from `POLL_HMAC_SECRET` (use
// `computePollSignature('')` from `./lib/auth.ts`).
//
// Concurrency: each invocation acquires `pg_try_advisory_xact_lock`. If
// another invocation already holds it (cron-job.org occasionally stacks
// after upstream slow responses), this returns `{skipped: true,
// reason: 'lock'}` without recording a run row.
//
// Cursor management: Gmail's history cursor is stored in
// `gmail_credentials.last_history_id`. First-run sets it from
// `users.getProfile.historyId` and exits. Steady-state advances it
// via compare-and-swap so concurrent advancers can't trample each
// other (defense in depth — the advisory lock should already serialize
// runs).
//
// 404 recovery: when Gmail returns 404 for a stale cursor (>~7 days
// old), the handler re-baselines from `users.getProfile` and skips
// classification this tick.
//
// Backfill phase: before history-list classification, the handler
// resolves `messages.gmail_thread_id` for fresh sends (NULL at mint
// time because the extension can't read the thread_id from the
// compose URL — Gmail assigns it server-side). See
// `lib/backfill-thread-ids.ts`. Failures are logged but do not abort
// the poll cycle.
//
// Drain step: after the classification transaction commits and the
// advisory lock is released, the handler iterates `pixel_hits` rows
// whose `notify_after` has elapsed and `tag` is still `'none'`, and
// calls `sendPushesForHit` for each. The drain runs OUTSIDE the
// transaction on purpose — a web-push HTTP failure must not roll back
// the cursor advance. `gmail_poll_runs.drained_pushes` is updated
// after the drain completes.

import type { Context } from '@netlify/functions';
import { withCors } from './lib/cors.js';
import { requirePollHmac } from './lib/auth.js';
import { respondError, respondJson } from './lib/respond.js';
import { pgClient } from './lib/db.js';
import { exchangeRefreshToken } from './lib/gmail-oauth.js';
import {
  HistoryNotFoundError,
  getProfile,
  historyList,
  type HistoryRecord,
} from './lib/gmail-api.js';
import { extractUnreadRemovedThreadIds } from './lib/classify-mobile-self-views.js';
import { backfillThreadIds } from './lib/backfill-thread-ids.js';
import { sendPushesForHit } from './lib/notify.js';

// Memorable, deterministic 32-bit constant. Postgres advisory locks are
// global per database; this key namespaces the email-tracker poller so
// other tenants of the same database (none today) wouldn't collide.
const POLLER_LOCK_KEY = 0x6574_706c; // "etpl"

// Bound history pagination per run. Gmail returns up to 100 records per
// page; 10 pages = 1000 records, plenty for a 5-minute window of a
// personal account. If we hit the bound, the leftover work is captured
// on the next tick because we don't advance the cursor past the last
// processed historyId.
const MAX_HISTORY_PAGES = 10;

interface CredsRow {
  user_id: string;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
  last_history_id: string | null;
}

// Cap on hits drained per poll cycle. Generous for a personal account
// (<50 hits/day) but a guardrail against a runaway state.
const MAX_DRAIN_PER_CYCLE = 100;

type TxOutcome =
  | { kind: 'short_circuit'; response: Response }
  | {
      kind: 'success';
      startedAt: string;
      historyRecordsCount: number;
      threadsClassified: number;
      hitsUpdated: number;
      newHistoryId: string;
      backfillCandidates: number;
      backfilled: number;
    };

async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== 'POST') {
    return respondError('method_not_allowed', 'POST required', 405);
  }

  const auth = await requirePollHmac(req);
  if (!auth.ok) return auth.response;

  const sql = pgClient();

  let outcome: TxOutcome;
  try {
    outcome = await sql.begin<TxOutcome>(async (tx) => {
      const lockRows = await tx<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${POLLER_LOCK_KEY}) AS locked
      `;
      if (!lockRows[0]?.locked) {
        return {
          kind: 'short_circuit',
          response: respondJson({ skipped: true, reason: 'lock' }),
        };
      }

      const startedAt = new Date();

      const credRows = await tx<CredsRow[]>`
        SELECT user_id, refresh_token, access_token, access_token_expires_at, last_history_id
        FROM public.gmail_credentials
        LIMIT 1
      `;
      if (credRows.length === 0) {
        await tx`
          INSERT INTO public.gmail_poll_runs (started_at, finished_at, ok, error)
          VALUES (${startedAt.toISOString()}, now(), false, 'no_credentials')
        `;
        return {
          kind: 'short_circuit',
          response: respondJson({ ok: false, reason: 'no_credentials' }),
        };
      }
      const cred = credRows[0]!;
      if (!cred.refresh_token) {
        await tx`
          INSERT INTO public.gmail_poll_runs (started_at, finished_at, ok, error)
          VALUES (${startedAt.toISOString()}, now(), false, 'oauth_revoked')
        `;
        return {
          kind: 'short_circuit',
          response: respondJson({ ok: false, reason: 'oauth_revoked' }),
        };
      }

      let accessToken = cred.access_token;
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAtSec = cred.access_token_expires_at
        ? Math.floor(new Date(cred.access_token_expires_at).getTime() / 1000)
        : 0;
      // Refresh if missing or within 30s of expiry.
      if (!accessToken || expiresAtSec < nowSec + 30) {
        try {
          const exchanged = await exchangeRefreshToken(cred.refresh_token);
          accessToken = exchanged.accessToken;
          await tx`
            UPDATE public.gmail_credentials
            SET access_token = ${exchanged.accessToken},
                access_token_expires_at = ${new Date(exchanged.expiresAt * 1000).toISOString()},
                updated_at = now()
            WHERE user_id = ${cred.user_id}
          `;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            JSON.stringify({ source: 'gmail-poll', stage: 'oauth-refresh', err: msg }),
          );
          await tx`
            INSERT INTO public.gmail_poll_runs (started_at, finished_at, ok, error)
            VALUES (${startedAt.toISOString()}, now(), false, ${`oauth_revoked: ${msg}`.slice(0, 500)})
          `;
          return {
            kind: 'short_circuit',
            response: respondJson({ ok: false, reason: 'oauth_revoked' }),
          };
        }
      }

      // First run: baseline the cursor and exit.
      if (!cred.last_history_id) {
        const profile = await getProfile(accessToken!);
        await tx`
          UPDATE public.gmail_credentials
          SET last_history_id = ${profile.historyId},
              updated_at = now()
          WHERE user_id = ${cred.user_id}
        `;
        await tx`
          INSERT INTO public.gmail_poll_runs (started_at, finished_at, ok, history_ids_processed, drained_pushes)
          VALUES (${startedAt.toISOString()}, now(), true, 0, 0)
        `;
        return {
          kind: 'short_circuit',
          response: respondJson({
            ok: true,
            baselined: true,
            history_id: profile.historyId,
          }),
        };
      }

      // Backfill `messages.gmail_thread_id` for fresh sends BEFORE
      // running history-list classification. The classifier JOINs
      // pixel_hits against `messages.gmail_thread_id`, so backfilling
      // first means a single poll cycle can both (a) discover the
      // thread_id for a recent send and (b) immediately tag any
      // mobile-self-view hits on that thread. Backfill failure is
      // logged but never aborts the poll — history-list still runs
      // for already-backfilled messages.
      let backfillResult = { candidates: 0, backfilled: 0 };
      try {
        backfillResult = await backfillThreadIds({
          sql: tx,
          userId: cred.user_id,
          accessToken: accessToken!,
        });
      } catch (err) {
        console.warn(
          JSON.stringify({
            source: 'gmail-poll',
            stage: 'backfill',
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      const expected = cred.last_history_id;

      // Pull history pages with 404 recovery.
      let history: HistoryRecord[] = [];
      let newHistoryId = expected;
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const result = await historyList({
            accessToken: accessToken!,
            startHistoryId: expected,
            historyTypes: ['labelRemoved'],
            labelId: 'UNREAD',
            pageToken,
          });
          history = history.concat(result.history);
          newHistoryId = result.historyId;
          if (!result.nextPageToken) break;
          pageToken = result.nextPageToken;
        }
      } catch (err) {
        if (err instanceof HistoryNotFoundError) {
          const profile = await getProfile(accessToken!);
          await tx`
            UPDATE public.gmail_credentials
            SET last_history_id = ${profile.historyId},
                updated_at = now()
            WHERE user_id = ${cred.user_id}
          `;
          await tx`
            INSERT INTO public.gmail_poll_runs
              (started_at, finished_at, ok, history_ids_processed, drained_pushes, error)
            VALUES (${startedAt.toISOString()}, now(), true, 0, 0, 'rebaselined_after_404')
          `;
          return {
            kind: 'short_circuit',
            response: respondJson({
              ok: true,
              rebaselined: true,
              history_id: profile.historyId,
            }),
          };
        }
        throw err;
      }

      const threadIds = extractUnreadRemovedThreadIds(history);

      // UPDATE matching pixel_hits within the 1-hour lookback window.
      let updatedCount = 0;
      if (threadIds.length > 0) {
        const updated = await tx<{ id: string }[]>`
          UPDATE public.pixel_hits ph
          SET tag = 'self_view_mobile', notify_after = NULL
          FROM public.messages m
          WHERE ph.message_id = m.id
            AND m.user_id = ${cred.user_id}
            AND m.gmail_thread_id IN ${tx(threadIds)}
            AND ph.hit_at > now() - interval '1 hour'
            AND ph.tag = 'none'
          RETURNING ph.id
        `;
        updatedCount = updated.length;
      }

      // Compare-and-swap the cursor.
      const cursorRows = await tx<{ user_id: string }[]>`
        UPDATE public.gmail_credentials
        SET last_history_id = ${newHistoryId}, updated_at = now()
        WHERE user_id = ${cred.user_id} AND last_history_id = ${expected}
        RETURNING user_id
      `;
      if (cursorRows.length === 0) {
        console.warn(
          JSON.stringify({
            source: 'gmail-poll',
            stage: 'cursor-cas',
            message: 'cursor moved underneath us',
            expected,
            new_history_id: newHistoryId,
          }),
        );
        await tx`
          INSERT INTO public.gmail_poll_runs
            (started_at, finished_at, ok, history_ids_processed, drained_pushes, error)
          VALUES (${startedAt.toISOString()}, now(), false, ${history.length}, 0, 'cursor_cas_failed')
        `;
        return {
          kind: 'short_circuit',
          response: respondJson({ ok: false, reason: 'cursor_cas_failed' }),
        };
      }

      // Success path: defer the run-row insert and the drain to AFTER
      // the transaction commits. The advisory lock + cursor CAS are now
      // safely persisted; subsequent web-push HTTP calls must not be
      // able to roll them back.
      return {
        kind: 'success',
        startedAt: startedAt.toISOString(),
        historyRecordsCount: history.length,
        threadsClassified: threadIds.length,
        hitsUpdated: updatedCount,
        newHistoryId,
        backfillCandidates: backfillResult.candidates,
        backfilled: backfillResult.backfilled,
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ source: 'gmail-poll', stage: 'unhandled', err: msg }),
    );
    // Best-effort error row outside the transaction (the original tx
    // rolled back). Use a fresh non-transactional query so this can't
    // cascade into another rollback.
    try {
      await sql`
        INSERT INTO public.gmail_poll_runs (started_at, finished_at, ok, error)
        VALUES (now(), now(), false, ${msg.slice(0, 500)})
      `;
    } catch {
      // Swallow — DB is already in a bad state and we've logged.
    }
    return respondError('internal_error', 'gmail poll failed', 500);
  }

  if (outcome.kind === 'short_circuit') {
    return outcome.response;
  }

  // Drain step. Runs OUTSIDE the transaction: a web-push failure must
  // not roll back the cursor advance recorded above. The advisory lock
  // is also released at this point — concurrent invocations are
  // possible, but `sendPushesForHit`'s per-(message, hour) CAS on
  // `messages.last_notified_at` prevents duplicate pushes.
  let drainedPushes = 0;
  try {
    const readyHits = await sql<{ id: string }[]>`
      SELECT id FROM public.pixel_hits
      WHERE tag = 'none'
        AND notified_at IS NULL
        AND notify_after IS NOT NULL
        AND notify_after < now()
      ORDER BY notify_after ASC
      LIMIT ${MAX_DRAIN_PER_CYCLE}
    `;
    for (const { id } of readyHits) {
      try {
        const result = await sendPushesForHit(sql, id);
        drainedPushes += result.pushes_sent;
      } catch (err) {
        console.error(
          JSON.stringify({
            source: 'gmail-poll',
            stage: 'drain',
            hit_id: id,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  } catch (err) {
    // Don't let a drain failure poison the run-row write below.
    console.error(
      JSON.stringify({
        source: 'gmail-poll',
        stage: 'drain-select',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  try {
    await sql`
      INSERT INTO public.gmail_poll_runs
        (started_at, finished_at, ok, history_ids_processed, drained_pushes)
      VALUES (${outcome.startedAt}, now(), true, ${outcome.historyRecordsCount}, ${drainedPushes})
    `;
  } catch (err) {
    console.error(
      JSON.stringify({
        source: 'gmail-poll',
        stage: 'run-row-insert',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return respondJson({
    ok: true,
    history_records: outcome.historyRecordsCount,
    threads_classified: outcome.threadsClassified,
    hits_updated: outcome.hitsUpdated,
    drained_pushes: drainedPushes,
    new_history_id: outcome.newHistoryId,
    backfill_candidates: outcome.backfillCandidates,
    backfilled: outcome.backfilled,
  });
}

export default withCors(handler);

export const config = { path: '/api/gmail-poll' };
