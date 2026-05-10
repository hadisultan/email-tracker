---
title: Classifier verdicts are the source of truth for downstream filtering — not raw signals
date: 2026-05-09
category: best-practices
module: functions/lib/tag-classifier.ts, dashboard/src/pages/Messages.tsx
problem_type: best_practice
component: email_processing
severity: medium
applies_when:
  - "Building any system that combines multiple raw signals into a classification"
  - "Adding filter UI that hides certain rows based on derived properties"
  - "Considering 'just filter by the raw signal' as a quick fix instead of updating the classifier"
tags:
  - architecture
  - classification
  - separation-of-concerns
  - dashboard
  - email-tracking
---

# Classifier verdicts are the source of truth for downstream filtering — not raw signals

## Context

The pixel-hits table stores both raw signals (`proxy_label`, `ip`, `user_agent`) and a classifier-derived verdict (`tag`). When a bug surfaced — Gmail's image proxy was producing spurious "opens" — there were two ways to suppress them:

1. **Raw-signal filter**: Skip `pixel_hits` rows where `proxy_label = 'google'` in the dashboard query, the push pipeline, etc.
2. **Verdict update**: Add a rule to `classifyHit()` so those rows are tagged `likely_prefetch` at insert time, then trust the tag everywhere.

We chose (2). This document explains why, and the principle behind it.

## Guidance

**Once a classifier exists, every downstream consumer should read the classifier's verdict, not the raw signals it consumed.** The classifier is the single place where the policy of "what counts as a real open?" lives. Filtering by raw signals downstream is a parallel, drift-prone re-implementation of that policy.

In practice for this codebase:

- ✅ `tag-classifier.ts` reads `proxy_label`, `sent_at`, `hit_at`, `recentBeacons`, `ua` and emits `tag`.
- ✅ The push pipeline reads `tag` to decide whether to set `notify_after`.
- ✅ The dashboard "Real opens" tab filters by `tag IN ('none', 'self_view_mobile')`.
- ✅ The hit-count badge on the dashboard counts hits whose `tag` matches the active filter.
- ❌ DO NOT filter by `proxy_label IN (NULL, 'apple_mpp')` in the dashboard or push pipeline. Even though the current tag definitions imply that mapping, it'll drift the moment the classifier adds a new rule.

## Why This Matters

Two concrete failure modes when downstream code re-derives from raw signals:

1. **False negatives.** Classifier says: "google-proxy hits past 60s ARE real opens" (the proxy is fetching on actual recipient render past delivery). Raw-signal filter says: "hide all proxy_label='google' rows." Result: real recipient opens flowing through Gmail's proxy past the 60s window get hidden. The user thinks no one opened the email.

2. **False positives.** Classifier says: "an IPv6 hit at +1s with the user's own UA is `likely_prefetch`." Raw-signal filter says: "show all rows where proxy_label IS NULL." Result: the user's own browser link-preview hit gets counted as a real open.

A third, slower failure mode: **drift**. When the classifier rule changes (e.g. tightening the prefetch window, adding a new proxy source), every downstream filter has to be updated in lockstep. Skipping any one of them produces silently inconsistent UI — the dashboard badge shows "3 opens" while the timeline below it shows "No opens yet" because the badge counted by raw signal and the timeline counted by tag.

## When to Apply

- Any time a system has a classification step that reduces multiple raw signals to a single verdict (a tag, label, severity, etc.). Once the classifier is the system of record, treat it as such.
- Any time you find yourself writing `WHERE raw_signal = X` in a downstream query "to fix" a misclassification. Stop. Fix the classifier instead, and let the existing tag filter pick up the corrected verdicts.
- Any time you add a new column to the dashboard that segments results by some raw property of the row. Ask: is this segmentation policy or display? If policy, it belongs in the classifier.

## Examples

**Bad:** dashboard adds a "hide Gmail proxy hits" toggle that filters by `proxy_label='google'` directly.

```tsx
// ❌ DO NOT DO THIS
const { data } = await sb.from('pixel_hits')
  .select('*')
  .eq('message_id', id)
  .neq('proxy_label', 'google');
```

**Good:** classifier learns "google-proxy hits ≤60s after send are prefetch", emits `tag='likely_prefetch'`, and the dashboard's existing tag filter does the work for free.

```ts
// functions/lib/tag-classifier.ts
if (input.proxyLabel === 'google' && input.sentAt) {
  const sinceSendMs = input.hitAt.getTime() - input.sentAt.getTime();
  if (sinceSendMs >= 0 && sinceSendMs < 60_000) {
    return 'likely_prefetch';
  }
}
```

```tsx
// dashboard — unchanged, no per-table policy code
const FILTER_TAGS = {
  real:   ['none', 'self_view_mobile'],
  hidden: ['self_view_desktop', 'likely_prefetch'],
};
```

**Counterexample where raw signals are appropriate:** displaying *informational* badges that describe the row, not classifying it. E.g., "📬 via Apple MPP" badge next to a hit with `proxy_label='apple_mpp'`. That's display, not policy — it doesn't decide whether the hit counts.

## Related

- `docs/solutions/logic-errors/gmail-image-proxy-delivery-prefetch-classification-2026-05-09.md` — the bug fix that motivated this principle.
