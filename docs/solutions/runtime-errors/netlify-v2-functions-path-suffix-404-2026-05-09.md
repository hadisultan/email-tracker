---
title: Netlify V2 functions on legacy auto-mount return 404 on path suffixes
date: 2026-05-09
category: runtime-errors
module: functions
problem_type: runtime_error
component: tooling
symptoms:
  - "Netlify function deployed but `/pixel/<token>` returns the SPA fallback HTML"
  - "`/.netlify/functions/pixel/abc` 404s; `/.netlify/functions/pixel` works"
  - "`export const config = { path: '/pixel/*' }` registers no route"
root_cause: wrong_api
resolution_type: config_change
severity: high
tags:
  - netlify
  - serverless
  - routing
  - functions-v2
  - redirects
---

# Netlify V2 functions on legacy auto-mount return 404 on path suffixes

## Problem

A Netlify V2 function (`functions/pixel.ts`) was meant to handle dynamic paths like `/pixel/<opaque-token>`. The function deployed successfully, the bare path `/.netlify/functions/pixel` worked, but anything with a suffix (`/.netlify/functions/pixel/abc`, `/pixel/abc`) returned the SPA fallback HTML instead of invoking the function. The whole tracking-pixel feature was broken in production despite passing all unit and integration tests.

## Symptoms

- `curl https://site.netlify.app/pixel/abc` returns `text/html` (the SPA `index.html`), not the expected `image/gif`.
- `curl https://site.netlify.app/.netlify/functions/pixel` does invoke the function, but `/.netlify/functions/pixel/abc` does not.
- Function logs show no invocation for any request that includes a path suffix.
- No error in the Netlify build log; the function is listed under "Functions" in the deploy summary.

## What Didn't Work

1. **`export const config = { path: '/pixel/*' }`** — the V2 routing config docs suggested wildcards. After deploy, the function still only responded at `/.netlify/functions/pixel`. No log line at deploy time saying the route registered or didn't.
2. **`export const config = { path: ['/pixel/:token', '/pixel'] }`** — array-of-paths form, also from the docs. Same outcome: silently registered no route.
3. **`netlify.toml` redirect: `from = "/pixel/*", to = "/.netlify/functions/pixel/:splat"`** — the redirect itself worked (HTTP 200 from the function), but only because Netlify's redirect engine fell through to the SPA when the function didn't handle the request. The function STILL didn't see path suffixes.

## Solution

Use a query-parameter redirect, not a path-segment one. Drop `export const config` from the function file entirely (rely on legacy auto-mount at `/.netlify/functions/<name>`) and rewrite the redirect:

```toml
# netlify.toml
[[redirects]]
  from = "/pixel/*"
  to = "/.netlify/functions/pixel?token=:splat"
  status = 200
  force = true
```

In the function, read the token from the query first, with a path-segment fallback for local dev / tests:

```ts
function extractToken(req: Request): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get('token');
  if (q && q.length > 0) return q;
  // Fallback for /.netlify/functions/pixel/<token> — works in dev/tests.
  const m = url.pathname.match(/\/pixel(?:\.[a-z]+)?\/([^/?]+)$/i);
  return m ? m[1]! : null;
}
```

## Why This Works

Netlify V2 functions on legacy auto-mount only respond at the EXACT path `/.netlify/functions/<name>`. Any path suffix silently falls through to the SPA fallback handler — the function is never invoked, no log line is emitted, no error is raised. Whether `config.path` wildcards work appears to depend on the account tier or some undocumented constraint; either way, the redirect-to-legacy-mount pattern is reliable across all known configurations.

Query-param redirects sidestep the whole path-suffix issue: the function receives a stable URL (`/.netlify/functions/pixel?token=abc`) regardless of the public-facing route.

## Prevention

- After deploying any function intended to handle dynamic paths, smoke-test from outside Netlify (`curl` from your local machine) at the *public* URL (`https://site.netlify.app/your-route/probe-value`), not just at `/.netlify/functions/<name>`.
- If you see the SPA HTML in the response body, the function isn't being invoked — check the redirect, not the function.
- Default to query-param redirects for any V2 function that needs dynamic input, until Netlify confirms `config.path` wildcards work on your tier.

## Related Issues

- N/A
