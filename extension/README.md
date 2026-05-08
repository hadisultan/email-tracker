# Email Tracker — Chrome Extension

Manifest V3 extension that pairs with the email-tracker backend (Netlify
Functions + Supabase) to inject tracking pixels into Gmail compose
windows and beacon self-views back to the server.

This README covers U6a (the foundation: manifest, build, popup pairing,
service-worker auth state). Compose-window injection is U6b; self-view
beacons and push subscription are U6c.

## Local dev

```bash
# 1. Install deps (run from repo root if not already done)
npm install

# 2. Build the extension
npm run build --workspace=extension

# 3. Load the unpacked extension in Chrome
#    chrome://extensions → toggle "Developer mode" → "Load unpacked"
#    → choose extension/dist/

# 4. Start the backend on localhost:8888
#    (in another shell)
netlify dev
```

The popup expects to talk to `http://localhost:8888` by default — see
`src/lib/config.ts`.

## Pairing flow (U6a)

1. Sign in to the dashboard and click **Generate pairing code** (the
   dashboard endpoint is U9; until then, hit
   `POST /api/pair-extension-create` directly with a Supabase JWT).
2. Click the extension icon. Paste the `XXXX-XXXX-XXXX-XXXX` code into
   the popup and click **Pair**.
3. On success the badge flips to **Paired ✓** and the service token is
   stored in `chrome.storage.local`. Reloading the extension preserves
   the pairing — storage is the single source of truth.

Failure modes the popup distinguishes:

- `code_invalid` — typo or unknown code
- `code_expired` — code older than 10 minutes
- `code_consumed` — code already used (single-use)
- `no_token` — the extension is not paired (only after U6b/U6c add
  authenticated calls)

## Production build

For a production build pointing at your deployed Netlify URL:

1. Edit `src/lib/config.ts` and replace the default API base URL.
2. Run `npm run build --workspace=extension`.
3. Run `npm run package --workspace=extension` to produce
   `extension/extension-v<version>.zip`.

### Stable extension ID

The dev build will get a different extension ID per machine, which means
`EXTENSION_ORIGIN` in the backend's CORS allowlist will not match. To pin
the ID across machines, generate a stable key:

1. Use Chrome's **Pack extension** action on a clean `dist/` to produce
   a `.crx` and `.pem` file once.
2. Extract the manifest `key` field from the `.crx` (the public key is
   embedded; tools like `chrome-extension-key` automate this) and paste
   it into `manifest.json` as `"key": "<base64-public-key>"`.
3. Derive the extension ID from the public key (mz-hash of the SHA-256
   per Chrome's docs) and set
   `EXTENSION_ORIGIN=chrome-extension://<derived-id>` in Netlify.

Until that's done, every fresh machine produces a new extension ID and
must be allowlisted manually.

## Icons

The PNGs in `assets/` are placeholder 1×1 transparent pixels — Chrome
scales them, which is acceptable for a personal unpacked extension.
Replace with proper 16/48/128 PNGs before any Chrome Web Store
submission (we don't plan to submit this one).

## Tests

```bash
# From repo root
npx vitest run --project extension
```

Tests use vitest's jsdom environment plus a small in-test stub for
`chrome.storage.local`. No `sinon-chrome` dependency.
