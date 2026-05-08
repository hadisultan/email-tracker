# Email Tracker

Personal Mailtrack/Mailsuite equivalent for a single Gmail account. Three surfaces glued together:

1. A **Manifest V3 Chrome extension** that injects a tracking pixel into Gmail compose and beacons self-views.
2. A **set of Netlify Functions** (pixel, mint, beacon, push-subscribe, gmail-poll, oauth-finalize, dashboard API) backed by **Supabase Postgres** + **Supabase Auth (Google OAuth)**.
3. A **static React dashboard** (Netlify CDN) for tracked messages, opens, system health, and Web Push opt-in.

A **cron-job.org schedule** pings `/api/gmail-poll` every 5 minutes to suppress mobile self-opens via the Gmail History API and to drain pending push notifications.

> **Status:** Unit 1 (repo scaffold) is complete. See `docs/plans/2026-05-08-001-feat-personal-email-tracker-plan.md` for the full implementation plan and per-unit checklist.

---

## Layout

```
.
├── extension/     Chrome MV3 extension (TypeScript, plain tsc)
├── functions/     Netlify Functions (TypeScript, esbuild via Netlify)
├── dashboard/     React + Vite static SPA
├── db/            Supabase migrations + reset/teardown scripts
└── docs/          Brainstorms, plans, solutions
```

---

## Prerequisites

- **Node.js ≥ 20** (Node 24 recommended). `node --version`.
- **Docker Desktop** running (for the local Supabase Postgres used by Unit 2+ tests).
- **Supabase CLI** — install from <https://supabase.com/docs/guides/cli/getting-started>.
- **Netlify CLI** (optional, for local function emulation): `npm install -g netlify-cli`.

---

## First-time setup walkthrough

This is a personal tool. The setup touches several systems; do them in order.

### 1. Supabase project

1. Create a new project at <https://supabase.com/dashboard>.
2. Project Settings → API: copy `URL`, `anon` key, and `service_role` key into `.env`.
3. Project Settings → Database: copy the connection string into `SUPABASE_DB_URL`.
4. Authentication → Providers → Google: enable, paste the Google OAuth client ID + secret (see step 2).

### 2. Google Cloud OAuth client

1. <https://console.cloud.google.com/apis/credentials> → Create Credentials → OAuth client ID → Web application.
2. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback` (from step 1).
3. **OAuth consent screen → publish to "In production"**. Do *not* leave it in "Testing" — testing-mode refresh tokens expire after 7 days. For a single-user app using only `gmail.metadata` for the operator's own account, no Google verification review is required.
4. Calendar an annual reminder to check the OAuth client's status page; Google occasionally requires re-verification of restricted scopes.
5. Copy the client ID + secret into `.env`.

### 3. Netlify

1. Create a new site at <https://app.netlify.com>; link it to this repo.
2. Site Settings → Environment variables: add every variable from `.env.example` (with real values).
3. The build command (`npm run build --workspace=dashboard`) and publish directory (`dashboard/dist`) come from `netlify.toml` — no manual config needed.

### 4. cron-job.org (5-minute poller)

1. Create a free account at <https://cron-job.org>.
2. Create a job:
   - Title: `email-tracker poll`
   - URL: `https://<your-netlify-site>/api/gmail-poll`
   - Schedule: `*/5 * * * *`
   - Request method: `POST`
   - Custom request header: `X-Signature: <hmac>` where `<hmac>` is computed once over an empty body using `POLL_HMAC_SECRET`. Compute it locally:
     ```bash
     node -e "console.log(require('crypto').createHmac('sha256', process.env.POLL_HMAC_SECRET).update('').digest('hex'))"
     ```
   - Save and use the "Test" button to confirm the function returns 200.

### 5. VAPID keypair (Web Push)

```bash
npx web-push generate-vapid-keys
```

Copy the printed keys into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Set `VAPID_CONTACT` to a `mailto:` URI on a domain you control.

> **Rotation note:** changing the VAPID keypair invalidates **all** existing push subscriptions silently. After rotation, every device must re-subscribe via the dashboard's "Subscribe to notifications" button.

### 6. Chrome extension

Build + load unpacked once Unit 6a lands. See `extension/README.md` (added in U6a) for the pairing flow.

---

## Local development

```bash
# Install all workspace dependencies.
npm install

# Run the dashboard dev server.
npm run dev --workspace=dashboard

# Run all tests.
npm test

# Type-check every workspace.
npm run lint
```

For local function emulation:

```bash
npm install -g netlify-cli
netlify dev
```

For local DB tests (Unit 2 onwards):

```bash
supabase start                       # boots local Postgres in Docker
./db/reset.sh                        # re-applies every migration from scratch
```

---

## Releasing the extension

```bash
npm run package --workspace=extension   # added in U6a — builds, zips, version-stamps
```

Distribute `extension/extension-vX.Y.Z.zip` via a GitHub Release for "install on a new machine"; load unpacked from `extension/dist/` for dev.

---

## Environment variables

Every variable lives in [`.env.example`](./.env.example) with a comment explaining its source and use.

> **Living-doc rule:** every implementation unit that introduces a new env var must amend BOTH `.env.example` AND this README's "Environment" section in the same PR.

---

## Schema iteration workflow

- During Units 2–9, migrations in `db/migrations/` are **rewritable**. Use `./db/reset.sh` for local wipes and `psql -f db/teardown.sql` + `supabase db push` for cloud wipes.
- After Unit 9 verification, migrations become **append-only**. Update this section to record the transition.
