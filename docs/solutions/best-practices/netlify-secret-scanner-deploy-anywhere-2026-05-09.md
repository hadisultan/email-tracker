---
title: Netlify's secret scanner is value-based — keep all env-var values out of source
date: 2026-05-09
category: best-practices
module: repo-wide
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Deploying a public or shared repo to Netlify"
  - "Authoring tests, fixtures, or docs that mention production hostnames or owner identifiers"
  - "Wanting the repo to be deployable by other people without source edits"
tags:
  - netlify
  - secrets
  - deployment
  - secret-scanning
  - deploy-anywhere
---

# Netlify's secret scanner is value-based — keep all env-var values out of source

## Context

Netlify scans every build for "exposed secrets". Crucially, the scanner is **value-based**, not key-based: any env-var value that appears literally in committed source (regardless of whether it's actually sensitive) fails the build with `Exposed secrets detected: <KEY>`.

This bites in non-obvious places:

- Your site's own public URL (`SITE_URL`, `DASHBOARD_ORIGIN`) — Netlify auto-sets `SITE_URL` to the deploy URL, so any test or doc that hard-codes `https://your-site.netlify.app` bricks deploys.
- The owner's email address (`OWNER_EMAIL_ALLOWLIST`) — a test fixture using `owner@gmail.com` literally as a recipient email will fail.
- Any other env var whose value is, say, a project ref (`SUPABASE_URL` contains the project ref) or a known constant.

## Guidance

**Treat the entire env-var table as a list of forbidden literals in source.** Even non-sensitive values must not appear, because the scanner can't tell the difference. Two concrete practices:

1. **Use placeholders + build-time substitution for code that needs a URL.** For our Chrome extension, `manifest.json` has `host_permissions: ["__API_BASE_HOST__/*"]` and `extension/build.mjs` text-replaces `__API_BASE_HOST__` from the `EMAIL_TRACKER_API_BASE` env var when copying to `dist/`. Source has no production URL; deployers run `EMAIL_TRACKER_API_BASE=https://their-site.netlify.app npm run build --workspace=extension`.

2. **Use generic placeholders in tests and fixtures.** `a@x.com`, `owner@example.com`, `https://example.com` — never the real owner's email or production URL. If a regression test really needs the production value, parameterize through `process.env` and supply via the Netlify env, not a literal.

## Why This Matters

- **Deploy-anywhere requires this.** Anyone forking the repo should be able to set their own `SITE_URL`, `OWNER_EMAIL_ALLOWLIST`, etc., without scrubbing source files.
- **Workarounds (`SECRETS_SCAN_OMIT_KEYS`) are brittle and grow over time.** Each new env var that happens to overlap with a literal in source adds another exemption. Eventually you've exempted everything and the scanner is useless. The structural fix — no values in source — costs nothing once set up and never grows.
- **Builds fail at the most inconvenient moments.** The scanner runs on every push, including the urgent hotfix you push at 11pm. A secret-scan failure has stopped real bug fixes from reaching production multiple times in this project's history.

## When to Apply

- Before any `git commit` that adds test fixtures, README examples, or default config values, scan the diff for production-looking strings (URLs, emails, project IDs, hostnames). Generic placeholders only.
- When introducing a new env var on Netlify, audit the codebase for any pre-existing literals that match its value — they need to be parameterized or replaced before the var is set.
- When forking or templating this repo, the placeholder pattern (`__API_BASE_HOST__` in manifest, env-driven build script) should be preserved as the deploy-anywhere contract.

## Examples

**Bad — hard-coded URL in extension manifest:**

```json
// extension/manifest.json
{
  "host_permissions": ["https://hadi-email-tracker.netlify.app/*"]
}
```

This fails Netlify's secret-scan because `SITE_URL` (and any other env var with the same value) is "exposed."

**Good — placeholder + build substitution:**

```json
// extension/manifest.json (committed)
{
  "host_permissions": ["__API_BASE_HOST__/*"]
}
```

```js
// extension/build.mjs (committed)
const apiBase = process.env.EMAIL_TRACKER_API_BASE ?? 'http://localhost:8888';
const manifest = await fs.readFile('manifest.json', 'utf-8');
await fs.writeFile(
  'dist/manifest.json',
  manifest.replaceAll('__API_BASE_HOST__', apiBase),
);
```

**Bad — owner email in test fixture:**

```ts
// recipient-label.test.ts
expect(recipientLabel('{owner@gmail.com}')).toBe('owner@gmail.com');
```

If `OWNER_EMAIL_ALLOWLIST=owner@gmail.com` on Netlify, this fails secret-scan.

**Good — generic placeholder:**

```ts
expect(recipientLabel('{owner@example.com}')).toBe('owner@example.com');
```

## Related

- The `extension/build.mjs` substitution pattern in this repo is the working reference implementation.
- `netlify.toml` does NOT use `SECRETS_SCAN_OMIT_KEYS`. If you find yourself reaching for it, prefer the structural fix.
