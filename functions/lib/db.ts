// Direct postgres connection for the Gmail poller (Unit 7).
//
// Why a separate client from `serviceRoleClient()`? `@supabase/supabase-js`
// does not expose explicit transactions, but the poller needs:
//   - `BEGIN; SELECT pg_try_advisory_xact_lock($k); …; COMMIT;` so concurrent
//     cron-job.org invocations don't stack on top of each other.
//   - Compare-and-swap on `gmail_credentials.last_history_id` performed
//     within the same transaction as the `pixel_hits` UPDATE.
//
// Using `postgres` (porsager/postgres) gives us first-class transactions
// (`sql.begin(async (tx) => …)`) and tagged-template parameter binding
// without manual quoting.
//
// Connection string: `SUPABASE_DB_URL` is the service-role connection
// string from Supabase project settings. Locally that's
// `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

import postgres, { type Sql } from 'postgres';

let cached: Sql | null = null;

export function pgClient(): Sql {
  if (cached) return cached;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL is not set');
  cached = postgres(url, {
    onnotice: () => {},
    // We previously set `fetch_types: false` here to skip the pg_type
    // catalog fetch on cold start. That had a hidden cost: without the
    // catalog, postgres-js cannot map array OIDs to their element type,
    // and `text[]` columns come back as raw wire-format strings like
    // `'{a@x.com,b@x.com}'`. `recipients.length` then reads the string
    // length, not the array length — which produced the "21 recipients"
    // notification body for a single-recipient message. The catalog
    // fetch is one tiny query and well worth it.
    max: 4,
    idle_timeout: 30,
  });
  return cached;
}

// Test-only: reset the cached client. Tests that swap env vars between
// cases call this so the next pgClient() call rebuilds against the new
// configuration.
export function _resetPgClientForTests(): void {
  if (cached) {
    void cached.end({ timeout: 1 }).catch(() => undefined);
  }
  cached = null;
}
