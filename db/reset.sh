#!/usr/bin/env bash
# db/reset.sh — local-dev DB wipe + re-apply all migrations.
#
# Local: rewinds the local Supabase Postgres and re-applies every migration in
# supabase/migrations/ from scratch. Requires Docker Desktop + the Supabase CLI.
# (The plan calls them "db/migrations/" but the Supabase CLI requires the
# supabase/ path; see db/README.md.)
#
#   $ ./db/reset.sh
#
# Cloud (pre-release iteration only): the Supabase CLI does NOT expose a hard
# wipe of the cloud project. Use the idempotent teardown script directly:
#
#   $ psql "$SUPABASE_DB_URL" -f db/teardown.sql
#   $ supabase db push --db-url "$SUPABASE_DB_URL"
#
# After Unit 9 verification, migrations become append-only; reset.sh remains
# valid for local dev but the cloud teardown path should be retired.

set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "error: supabase CLI not found on PATH." >&2
  echo "install: https://supabase.com/docs/guides/cli/getting-started" >&2
  exit 1
fi

echo "==> resetting local Supabase Postgres + re-applying migrations"
supabase db reset
echo "==> done"
