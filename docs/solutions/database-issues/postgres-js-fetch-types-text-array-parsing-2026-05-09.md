---
title: postgres-js fetch_types=false silently breaks text[] parsing
date: 2026-05-09
category: database-issues
module: functions/lib/db.ts
problem_type: database_issue
component: database
symptoms:
  - "Push notification body says \"21 recipients\" for a single-recipient message"
  - "DB has recipients = ['user@example.com'] (n=1) but app reads it as a 21-char string"
  - "recipients.length returns 21 instead of 1"
root_cause: config_error
resolution_type: config_change
severity: high
tags:
  - postgres
  - postgres-js
  - text-array
  - type-parsing
  - notification
---

# postgres-js fetch_types=false silently breaks text[] parsing

## Problem

The Web Push notification body rendered as `"21 recipients — Opened just now"` for a message that had a single recipient (`user@example.com`) in the database. The push pipeline read the `recipients` column from `messages` and called `.length` on it; the result was always 21 regardless of the actual number of addresses. No error was raised; the code just returned the wrong value.

## Symptoms

- Notification body says "21 recipients" while `SELECT array_length(recipients, 1) FROM messages WHERE id = ...` returns 1.
- The displayed count exactly equals `length('{<owner-email>}')` — the character count of the wire-format string, including the braces. For our 19-character owner email, that's 21. A different email length would have produced a different bogus count.
- `recipients` typed as `string[]` in TypeScript but at runtime is the literal string `"{owner@example.com,other@example.com}"`.
- All unit tests pass — they construct their own `postgres()` clients without the offending option.

## What Didn't Work

1. **Looking at the chip-selector in the extension** — assumed the recipients array was being inflated at write time (compose handler reading 21 emails out of the DOM). The DB query proved this wrong: every row had `array_length(recipients, 1) = 1`.
2. **Looking at the recipient-extraction code in mint.ts** — also fine. The array was correct on the way in.

## Solution

Remove `fetch_types: false` from the `postgres()` client options:

```ts
// functions/lib/db.ts — BEFORE
cached = postgres(url, {
  onnotice: () => {},
  fetch_types: false,   // ❌ disables type catalog
  max: 4,
  idle_timeout: 30,
});

// functions/lib/db.ts — AFTER
cached = postgres(url, {
  onnotice: () => {},
  // fetch_types defaults to true. Without the catalog, postgres-js cannot
  // map array OIDs to their element type and text[] columns come back as
  // raw wire-format strings.
  max: 4,
  idle_timeout: 30,
});
```

Belt-and-suspenders: also harden the consumer to defensively re-parse if the driver ever regresses:

```ts
function recipientLabel(recipients: string[] | string | null): string {
  let arr: string[];
  if (recipients == null) arr = [];
  else if (Array.isArray(recipients)) arr = recipients;
  else if (typeof recipients === 'string') {
    const trimmed = recipients.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1);
      arr = inner.length === 0 ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
    } else {
      arr = trimmed.length === 0 ? [] : [trimmed];
    }
  } else arr = [];
  if (arr.length === 0) return '(no recipients)';
  if (arr.length === 1) return arr[0]!;
  return `${arr.length} recipients`;
}
```

## Why This Works

`postgres-js` (`porsager/postgres`) ships with hard-coded support for well-known type OIDs (int, text, timestamptz, jsonb, etc.). Array types use *catalog OIDs* — the OID is allocated per element type when the table is created, so the driver can't recognize them without first reading `pg_type`. Setting `fetch_types: false` skips that read, intending to save one tiny query at cold start. The cost is that every `text[]`, `int[]`, etc. column comes back as the raw wire-format string (`'{a,b,c}'`), with no warning.

`.length` on that string returns the number of characters (including `{` and `}`), not the array length — so a single-element `{<owner-email>}` produces a count equal to `length(email) + 2`, which is what the user saw rendered as "21 recipients" in the notification body.

The catalog read is one trivial query at first connect. Skipping it is rarely worth the loaded foot-gun.

## Prevention

- Default to leaving `fetch_types` at its default (`true`) unless you have measured cold-start data showing the catalog read is a meaningful cost.
- Add at least one integration test per `text[]` (or any non-builtin-type) column that asserts the value comes back as `Array.isArray(...)`. A unit test using a fresh `postgres()` client won't catch driver-config regressions in the shared client; reuse the production `pgClient()` factory in tests where possible.
- Treat any `string`-typed value flowing into `.length` arithmetic as a tripwire: if the source is a DB column, double-check the runtime shape.

## Related Issues

- N/A
