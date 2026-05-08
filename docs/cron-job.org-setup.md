# cron-job.org setup for the Gmail poller

The `/api/gmail-poll` endpoint is HMAC-gated. cron-job.org drives it
every 5 minutes with a static signature computed once over an empty
body. **There is no GitHub Actions workflow** — the poller is plain
HTTP from cron-job.org to a Netlify Function.

## One-time setup

### 1. Generate the HMAC secret

Run locally and stash the value in your password manager:

```sh
openssl rand -base64 32
```

This is `POLL_HMAC_SECRET`. Set it on Netlify (Site → Environment
Variables) and on cron-job.org (the request will carry the static
signature derived from this secret).

### 2. Compute the static signature

The signature is `HMAC-SHA256(secret, body)` rendered as lowercase hex.
Because cron-job.org POSTs an empty body, the signature is computed
once over the empty string and reused on every invocation.

```sh
node --input-type=module -e "
  import('node:crypto').then(({ createHmac }) => {
    const sig = createHmac('sha256', process.env.POLL_HMAC_SECRET).update('').digest('hex');
    console.log(sig);
  });
"
```

…or from inside this repo:

```sh
node --input-type=module -e "
  import('./functions/lib/auth.js').then(({ computePollSignature }) => console.log(computePollSignature('')));
"
```

### 3. Create the cron-job.org job

| Field            | Value                                          |
| ---------------- | ---------------------------------------------- |
| Title            | `email-tracker poll`                           |
| URL              | `https://<your-netlify-site>/api/gmail-poll`   |
| Schedule         | `*/5 * * * *` (every 5 minutes)                |
| HTTP method      | `POST`                                         |
| Request body     | (leave empty)                                  |
| Custom header 1  | `X-Signature: <static signature from step 2>`  |
| Custom header 2  | `Content-Type: application/json`               |
| Notifications    | Enable failure notifications to your email     |
| Save responses   | On (helpful when debugging the first few runs) |

cron-job.org's free tier allows up to 1-minute granularity and unlimited
jobs, well within our 5-minute cadence.

### 4. Verify the wiring

Click the job's **"Run now"** button. cron-job.org will POST to the
URL with the static signature and you should see:

- 200 response with `{ok: true, baselined: true, history_id: ...}` on
  the first successful run (the poller seeds `last_history_id` and
  exits without classifying).
- A `gmail_poll_runs` row with `ok=true` in Supabase (Studio → Table
  Editor → `gmail_poll_runs`).

Subsequent runs return `{ok: true, history_records, threads_classified,
hits_updated, drained_pushes, new_history_id}` on success or
`{skipped: true, reason: 'lock'}` if another invocation is already
running.

## Operational signals

These are the response shapes you may see; all are 200 unless noted.

| Body                                          | Meaning                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `{ok: true, baselined: true, ...}`            | First-run cursor seeded. Subsequent runs will classify and drain.                                        |
| `{ok: true, hits_updated: N, drained_pushes: M, ...}` | Normal steady-state run; `N` pixel hits flipped to `self_view_mobile`, `M` web pushes delivered. |
| `{ok: true, rebaselined: true, ...}`          | Gmail returned 404 (cursor older than ~7 days); poller reset to current `historyId` and skipped this tick. |
| `{skipped: true, reason: 'lock'}`             | Another invocation was running; this one harmlessly noop'd. Common after a slow upstream tick.           |
| `{ok: false, reason: 'no_credentials'}`       | No `gmail_credentials` row yet; sign in via the dashboard.                                               |
| `{ok: false, reason: 'oauth_revoked'}`        | Refresh token missing or rejected; re-OAuth via the dashboard.                                           |
| `{ok: false, reason: 'cursor_cas_failed'}`    | Two invocations raced past the advisory lock (rare). Next tick will catch up.                            |
| HTTP 401 + `{error: {code: 'invalid_token'}}` | `X-Signature` missing or wrong. Recompute and update cron-job.org.                                       |
| HTTP 500 + `{error: {code: 'internal_error'}}`| Unhandled exception; check Netlify function logs.                                                        |

## Failure recovery

| Symptom                                                  | Fix                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `oauth_revoked` rows stacking up                         | Open the dashboard, sign out, sign back in with Google. Supabase OAuth flow returns a fresh refresh token.             |
| 404s from cron-job.org (Netlify function path wrong)     | Confirm `functions/gmail-poll.ts` exports `config = { path: '/api/gmail-poll' }` and Netlify deployed the latest build.|
| `lock` skips for >30 minutes                             | A prior run is wedged. Inspect the `pg_locks` view in Supabase Studio for a stuck `pg_advisory_xact_lock`.             |
| HMAC drift after secret rotation                         | Recompute the static signature on the new secret and update the cron-job.org `X-Signature` header.                     |

## Why not GitHub Actions?

The plan considered GH Actions; cron-job.org won because:

- Free, no commit-history pollution from heartbeat scheduled-workflow runs.
- 1-minute granularity vs. GH Actions' best-effort 5-minute floor.
- Static request shape — no need to manage a workflow file when only the secret rotates.
