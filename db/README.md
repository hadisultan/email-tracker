# Database

Schema, migrations, and seed for the personal email tracker.

## Layout

```
supabase/migrations/   migration files (Supabase CLI convention)
  0001_extensions.sql  pgcrypto
  0002_init.sql        tables + indexes
  0003_rls.sql         row-level security
  0004_views.sql       system_health view
db/seed.sql            single owner row
db/teardown.sql        idempotent DROPs (drives db/reset.sh)
db/reset.sh            wipe + reapply migrations + seed (local only)
```

### Why migrations live under `supabase/`

The original plan (`docs/plans/2026-05-08-001-feat-personal-email-tracker-plan.md`,
Unit 2) put migrations at `db/migrations/`. The Supabase CLI requires
them at `supabase/migrations/` so `supabase db reset`, `supabase db
push`, and the diff/lint tooling all work. We chose tooling
compatibility; this is documented as an intentional deviation.

## Run order

```
extensions -> init -> rls -> views -> seed
```

Migrations are applied alphabetically by the Supabase CLI, so the
`0001_`, `0002_`, ... prefixes carry the order. Seed runs after every
migration (it is not a migration itself).

RLS must exist before the seed runs - not because the seed would
otherwise fail (the seed is loaded under the `postgres` superuser
which has `BYPASSRLS`), but because anyone reading the seed file in
isolation should see RLS already in force on `public.users`.

## Local development

```bash
# Boot the local stack (Postgres on :54322, Studio on :54323, etc.):
supabase start

# Apply migrations + seed to a fresh DB:
supabase db reset

# Schema only - no seed - against an already-running DB:
supabase db push
```

`supabase db reset` runs every migration in `supabase/migrations/` then
loads `supabase/seed.sql` if present. We don't keep a `supabase/seed.sql`
because it is awkward to share with non-local environments; the
canonical seed is `db/seed.sql`, applied manually:

```bash
psql "$SUPABASE_DB_URL" -f db/seed.sql
```

`db/reset.sh` (from Unit 1) wraps the wipe + reset flow for local
dev; it is not used in production.

## Connecting

Local Postgres URL after `supabase start`:

```
postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

For tests and scripts, set `SUPABASE_DB_URL` to that string (see
`.env.example`). The functions workspace uses `postgres` (porsager) as
its Postgres client; tests live under `functions/__tests__/db/`.

## Schema-iteration workflow

Pre-release (through Unit 9 in the plan): destructive resets are fine.
Wipe and reapply at will using `db/reset.sh`.

Post-release: forward-only migrations.

- New work goes in a new migration file with the next `NNNN_` prefix.
- Never edit a migration that has been applied to production.
- Migrations are checked in with the rest of the unit's code; CI runs
  `supabase db push` against an ephemeral DB and `npm test` to
  validate.

## Schema-evolution playbook

Use additive changes by default and break them into deploy-friendly
phases.

| Change                  | Phase 1 (deploy)                    | Phase 2 (after grace period)      |
|-------------------------|--------------------------------------|------------------------------------|
| Add a column            | `ALTER TABLE ... ADD COLUMN ... NULL`| Tighten with `NOT NULL` once reads/writes have caught up |
| Rename a column         | Add new column, double-write         | Drop old column                    |
| Change a column type    | Add new column, double-write, swap reads | Drop old column                |
| Drop a column           | Stop writing to it; retain for 1 deploy | Drop it                         |
| Drop a table            | Stop reading and writing             | Drop it                            |
| Tighten a constraint    | Backfill, then add NOT VALID + VALIDATE | -                              |

Drops only land after a deployed grace period during which no code
references the dropped object - keeps rollbacks safe.

## Tables at a glance

| Table                | Purpose                                                    |
|----------------------|------------------------------------------------------------|
| `users`              | Owner identity. PK is the Supabase `auth.users.id`.         |
| `gmail_credentials`  | OAuth refresh + access token, last `historyId`.            |
| `service_tokens`     | Bearer tokens for the Chrome extension (hashed).           |
| `pairing_codes`      | Short-lived dashboard -> extension handshake (hashed).     |
| `messages`           | One row per minted tracking token; `client_send_id` UNIQUE.|
| `pixel_hits`         | One row per pixel load; tag enum-by-convention.            |
| `self_view_beacons`  | Extension beacons used to suppress sender's own opens.     |
| `push_subscriptions` | Web-Push subscriptions.                                    |
| `gmail_poll_runs`    | Observability for the cron poller.                         |

`system_health` (view) exposes exactly four signals to the
authenticated user: last pixel hit, last successful poll, OAuth
expiry, last successful push.

## RLS summary

| Table                | anon | authenticated (own rows)        | service-role |
|----------------------|------|----------------------------------|--------------|
| users                | -    | -                                | full         |
| gmail_credentials    | -    | -                                | full         |
| service_tokens       | -    | -                                | full         |
| pairing_codes        | -    | -                                | full         |
| messages             | -    | SELECT                           | full         |
| pixel_hits           | -    | SELECT (via parent message)      | full         |
| self_view_beacons    | -    | SELECT                           | full         |
| push_subscriptions   | -    | SELECT                           | full         |
| gmail_poll_runs      | -    | -                                | full         |
| system_health (view) | -    | SELECT (own row only)            | full         |

`service-role` bypasses RLS via Postgres-level `BYPASSRLS`; no
policies are required for it.

## `system_health` view: SECURITY DEFINER deviation

The plan's Unit 2 spec calls for `WITH (security_invoker = true)` on
the view. That is incompatible with the deny-all RLS on
`gmail_credentials` and `gmail_poll_runs` - a SECURITY INVOKER view
would return NULL for `oauth_expiry` and `last_poll_success_at` for
every authenticated user, defeating two of the four signals.

The migration uses `WITH (security_invoker = false)` (i.e. the default
SECURITY DEFINER) plus an explicit `WHERE u.id = auth.uid()` filter.
This achieves the same security property the plan was reaching for:
only the caller's own row is visible, and an anon connection (where
`auth.uid()` is NULL) sees zero rows. The view exposes only four
scalar signals - never raw `refresh_token` or `access_token`.

`SELECT` on `system_health` is granted to `authenticated` only, not to
`anon`.
