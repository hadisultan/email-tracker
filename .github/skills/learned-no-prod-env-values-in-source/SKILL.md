---
name: learned-no-prod-env-values-in-source
description: "[Auto-generated] Never write the literal value of any deploy-target env var (SITE_URL, OWNER_EMAIL_ALLOWLIST, SUPABASE_URL, etc.) in committed source. Netlify's secret scanner is value-based and will fail the build. Use when authoring tests, fixtures, configs, README examples, or any code that mentions URLs/emails/IDs."
---

# No Production Env-Var Values in Source (Learned)

> **Auto-generated** by `/evolve` from `.atv/instincts/project.yaml` on 2026-05-10.
> Source instinct: `no-prod-env-values-in-source` (confidence 0.85, 5 observations).
> Edit freely — this is a starting point.

## The Rule

**The literal value of any env var configured on the Netlify deploy target must not appear anywhere in committed source.**

Netlify's secret scanner is **value-based**, not key-based. It scans every build for any string that exactly matches an env-var value and fails the build with:

```
Exposed secrets detected: <KEY>
Build script returned non-zero exit code: 2
```

This applies regardless of whether the value is "actually sensitive." `SITE_URL` (your own public hostname) is auto-set by Netlify on every site and triggers the scanner the moment you commit a literal match.

## When to Apply

This rule is in scope for **any** `git add`-ed file. Especially:

- Test fixtures and assertions (e.g. `expect(x).toBe('owner@example.com')`)
- Default values in config files
- README usage examples
- Code comments containing illustrative URLs
- **Documentation, including `docs/solutions/` learning docs** (this rule was violated by the very doc that documented it — see commit `73059a0`)
- JSON manifests (e.g. `manifest.json` `host_permissions`)

## What Counts as a "Production Value"

| Env var | Watch for |
|---|---|
| `SITE_URL` | Your `<name>.netlify.app` hostname or custom domain |
| `DASHBOARD_ORIGIN` | Same as `SITE_URL` for this project |
| `OWNER_EMAIL_ALLOWLIST` | The owner's real email address |
| `SUPABASE_URL` | Contains the project ref — fails as a literal |
| `SUPABASE_*` keys, `VAPID_*`, `POLL_HMAC_SECRET` | Obviously sensitive |
| Anything else in your Netlify env table | Yes, that too |

## How to Comply

### 1. Generic placeholders in tests, fixtures, docs

| Don't | Do |
|---|---|
| `owner@gmail.com` | `owner@example.com`, `a@x.com` |
| `https://my-site.netlify.app` | `https://your-site.netlify.app`, `https://example.com` |
| `xyzproject` (Supabase project ref) | `your-project-ref` |

### 2. Placeholder + build-time substitution for built artifacts

When a committed file *must* end up with the production URL after build (e.g. `extension/manifest.json` `host_permissions`), use a placeholder token in source and substitute at build time:

```json
// extension/manifest.json (committed)
{
  "host_permissions": [
    "https://mail.google.com/*",
    "__API_BASE_HOST__/*"
  ]
}
```

```js
// extension/build.mjs (committed)
import { readFileSync, writeFileSync } from 'node:fs';
const API_BASE = process.env.EMAIL_TRACKER_API_BASE ?? 'http://localhost:8888';
const manifestSrc = readFileSync('manifest.json', 'utf8');
writeFileSync(
  'dist/manifest.json',
  manifestSrc.replaceAll('__API_BASE_HOST__', API_BASE),
);
```

The committed source has only the placeholder; the deploy-target value lives in the env and is injected at build.

### 3. Fetch secrets dynamically in tests

When a regression test needs a real env value, read it from `process.env`:

```ts
const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) throw new Error('SUPABASE_URL not set');
```

Don't hardcode the value as a literal "for convenience."

## Anti-Pattern: `SECRETS_SCAN_OMIT_KEYS`

It's tempting to add the offending key to `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml`. Resist:

- Each new var that overlaps with a literal in source adds another exemption.
- The list grows unboundedly until the scanner is effectively off.
- The structural fix (no values in source) costs nothing once set up and never grows.

This repo's `netlify.toml` deliberately does NOT use `SECRETS_SCAN_OMIT_KEYS`. If you find yourself reaching for it, prefer the structural fix.

## Pre-Commit Self-Check

Before committing any change to:

- `*.test.ts`, `*.test.tsx`, `__tests__/`
- `*.json` (especially `manifest.json`)
- `docs/**/*.md`
- `README.md`, `*.md` examples
- `.env.example` (it's checked in!)

…grep the diff for production-looking strings:

```sh
git diff --cached | grep -iE "netlify\.app|gmail\.com|supabase\.co"
```

Anything that matches should be a generic placeholder, not a real value.

## Recovery: when the scan fails

1. Read the failure message — it names the `<KEY>` that matched.
2. Look up that key's value in Netlify's env table.
3. `git grep` for the value across the repo. The scanner is exact-literal, so the offending occurrence will be there.
4. Replace with a placeholder, recommit, push.

## Evidence

This skill graduated from the `no-prod-env-values-in-source` instinct after the 5th observation. Source commits:

- `5b71c1e` — replaced literal owner email with `owner@example.com` in `recipient-label.test.ts` after secret-scan failure.
- `27721b1` — parameterized `API_BASE` out of source via `__API_BASE_HOST__` placeholder.
- `a65f2bd` — exempted `DASHBOARD_ORIGIN` from secret scanning (a temporary workaround that the structural fix later replaced).
- `f8dfb6b` — scrubbed literal Supabase keys from tests, fetched dynamically.
- `73059a0` — scrubbed the literal `SITE_URL` from the very doc that warned against this. Three production deploys (`5f3f999`, `79b1ca8`, `24e28e4`) failed the secret scan in a row before this fix landed.

The 5th occurrence was the meta-violation: the doc explaining the rule violated the rule. That alone justifies promoting it to an auto-discoverable skill so future agents see it before they author docs about other rules.

## Related

- `docs/solutions/best-practices/netlify-secret-scanner-deploy-anywhere-2026-05-09.md` — the underlying writeup with code examples.
- `docs/solutions/best-practices/classifier-verdict-vs-raw-signals-2026-05-09.md` — sibling architectural rule for this project.
