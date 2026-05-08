---
title: React lazy-loaded child cache becomes stale when parent prop changes
date: 2026-05-08
category: ui-bugs
module: dashboard
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - Already-expanded message rows kept showing the previous filter's open events after the user switched filter pills (real / all / hidden) on the Messages page
  - First expand worked correctly; subsequent expands after a filter change re-used the same cached data
  - No console warnings, no failing tests — the bug only surfaced through manual interaction during U9 self-review
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - react
  - useeffect
  - stale-state
  - lazy-loading
  - prop-changes
  - cache-invalidation
---

# React lazy-loaded child cache becomes stale when parent prop changes

## Problem

`MessageRow` lazily loads pixel-hit data on first expand and caches it in component state to avoid re-fetching on subsequent expand/collapse cycles. When the parent `Messages` page changed the active filter pill (which is passed to every row as a prop), already-expanded rows continued to display the previously-cached hits filtered under the old criteria. The user saw "Real opens" data while the filter pill said "All".

## Symptoms

- Toggle filter pill from `real` → `all` while a row is expanded → row still shows only `real`-filtered hits.
- Collapse then re-expand the same row → still shows the original cached set, not refetched under the new filter.
- Expanding a *different* row works correctly (it loads fresh data with the current filter).
- Tests passed because every existing test rendered a single row at a single filter value — none rerendered with a changed `filter` prop.

## What Didn't Work

- **Adding `filter` to the existing fetch dependency check in `toggle()`.** The original guard was `if (hits !== null) return;` — even with the filter-change useEffect added, this still skipped the fetch on re-expand because `hits` was non-null from the previous load.
- **Resetting `hits` to `null` inside a `useEffect(..., [filter])` that also handled the visible-row refetch.** The naive version broke 3 of 9 existing tests because the load now happened inside an async `.then()` callback outside React Testing Library's `act()` wrapper, producing flaky state-update timing on `findByText`.
- **Parent passing `key={`${filter}-${m.id}`}` to force a remount on filter change** (the reviewer's first suggestion). Works, but discards `expanded` state across filter changes — the user's mental model is "I expanded this row to keep watching it; switching filter shouldn't collapse everything I've opened".

## Solution

Track which filter value produced the currently-cached hits. Invalidate or refetch when the active filter diverges from it.

```tsx
// dashboard/src/components/MessageRow.tsx
export function MessageRow({ message, filter, loadHits }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [hits, setHits] = useState<PixelHit[] | null>(null);
  const [loadedFilter, setLoadedFilter] = useState<Filter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchHits(currentFilter: Filter): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const data = await loadHits(message.id, currentFilter);
      setHits(data);
      setLoadedFilter(currentFilter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // If the parent filter changes while expanded, refetch immediately so the
  // visible timeline reflects the new filter. If collapsed, just clear the
  // cached hits so the next expand fetches under the right filter.
  useEffect(() => {
    if (loadedFilter !== null && loadedFilter !== filter) {
      if (expanded) {
        void fetchHits(filter);
      } else {
        setHits(null);
        setLoadedFilter(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (hits !== null && loadedFilter === filter) return;
    await fetchHits(filter);
  }
  // ... render
}
```

Two regression tests pin the behaviour:

```tsx
// dashboard/__tests__/MessageRow.test.tsx
it('refetches with the new filter when the filter changes while expanded', async () => {
  const loader = vi.fn().mockImplementation(async (_id, f) =>
    f === 'real' ? [realHit] : [realHit, allHit],
  );
  const { rerender } = render(
    <MessageRow message={baseMessage} filter="real" loadHits={loader} />,
  );
  await userEvent.click(screen.getByRole('button', { expanded: false }));
  expect(await screen.findByText('Boston, US')).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(1);

  rerender(<MessageRow message={baseMessage} filter="all" loadHits={loader} />);
  expect(await screen.findByText('NYC, US')).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(loader).toHaveBeenLastCalledWith('m1', 'all');
});

it('drops cached hits when the filter changes while collapsed and re-fetches on next expand', async () => {
  const loader = vi.fn().mockResolvedValue([] as PixelHit[]);
  const { rerender } = render(
    <MessageRow message={baseMessage} filter="real" loadHits={loader} />,
  );
  await userEvent.click(screen.getByRole('button', { expanded: false }));
  expect(loader).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { expanded: true }));

  rerender(<MessageRow message={baseMessage} filter="all" loadHits={loader} />);
  expect(loader).toHaveBeenCalledTimes(1);   // not refetched yet — collapsed

  await userEvent.click(screen.getByRole('button', { expanded: false }));
  expect(loader).toHaveBeenCalledTimes(2);
  expect(loader).toHaveBeenLastCalledWith('m1', 'all');
});
```

## Why This Works

The original code violated a core invariant: **when you cache the result of a function call in component state, you must also cache the inputs that produced it**. `loadHits(messageId, filter)` is a function of two arguments; caching only the result without the inputs means the cache is implicitly keyed on whatever `filter` was at the time of the *first* fetch. Subsequent prop changes have no way to invalidate it.

The fix introduces `loadedFilter` as the second half of the cache key. The cache hit check becomes `hits !== null && loadedFilter === filter` instead of `hits !== null`. The dedicated `useEffect` watching `filter` handles the case where the row is currently expanded (refetch immediately so the visible UI updates without requiring user interaction) versus collapsed (clear lazily — next expand will refetch). Splitting the toggle path from the prop-change path keeps state updates in `act()`-wrapped contexts during testing.

## Prevention

- **Pattern: cache the inputs alongside the output.** When introducing per-component lazy data caches, the cache invariant must include every value the fetch depends on (ids, filters, paging cursors). A cached value of `null` means "not loaded"; a cached value plus mismatched inputs means "stale, refetch".
- **Test rerender with changed props.** Any component that takes a prop and uses it inside an async fetch should have at least one test that calls `rerender()` with the prop changed, asserting the new behaviour. Using React Testing Library's `rerender` is the equivalent of "user interacted with parent".
- **When a `useEffect` only handles the prop-change branch, suppress the lint rule deliberately.** `eslint-disable-next-line react-hooks/exhaustive-deps` is correct here — adding `expanded`, `loadedFilter`, etc. would re-run the effect on internal state changes and cause refetch loops. The comment marker forces future readers to think about why.
- **For shallow lazy caches, prefer `key=` on the parent.** When the cached state has no UX value across the prop change (e.g., the user's mental model is "filter changes start a fresh view"), the simpler fix is `<MessageRow key={`${filter}-${m.id}`} ...>`. Choose between in-component cache invalidation and remount-via-key based on whether internal state (expanded, scroll position) should survive the prop change. Document the choice in a comment.
- **Add the pattern to code-review heuristics.** Reviewers should flag any `useState<T | null>(null)` initialized in a child component followed by a fetch keyed on a prop, asking: "what happens when the prop changes after the fetch?"

## Related Issues

- Originating commit: `ed6eb52` — feat(dashboard): U9 dashboard UI with messages, health, and push opt-in.
- Plan reference: `docs/plans/2026-05-08-001-feat-personal-email-tracker-plan.md` Unit 9 (line 1762), R15 (tag-based opens filtering).
- Reviewer who caught it: Tier-2 ce-review of U9 (pre-commit), classified as CRITICAL: MessageRow filter-change staleness.
- Sister bug fixed in the same review pass: orphan-row filter on `Messages.tsx` was missing `gmail_message_id IS NULL` predicate per plan line 1784. Different surface (parent page filter logic), same review iteration.
