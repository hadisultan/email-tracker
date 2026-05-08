// Pure classifier: extract Gmail thread IDs whose UNREAD label was
// removed in the supplied history records.
//
// Why "extract" not "classify": Gmail's `users.history.list` response
// returns a stream of records that the poller must reduce to "which
// threads got marked-as-read this tick?" The actual pixel-hit
// classification (find recent `pixel_hits` rows for those threads,
// flip their tag) happens against Postgres in the handler.
//
// Defense in depth: the API call already passes `labelId=UNREAD` so
// Gmail server-side filters to UNREAD removals. We re-check
// `labelIds.includes('UNREAD')` here because Gmail occasionally
// piggybacks unrelated label changes in the same record, and we
// must not classify those as mobile self-views.

import type { HistoryRecord } from './gmail-api.js';

export function extractUnreadRemovedThreadIds(
  history: ReadonlyArray<HistoryRecord>,
): string[] {
  const seen = new Set<string>();
  for (const record of history) {
    const removed = record.labelsRemoved;
    if (!Array.isArray(removed)) continue;
    for (const lr of removed) {
      if (!Array.isArray(lr.labelIds)) continue;
      if (!lr.labelIds.includes('UNREAD')) continue;
      const threadId = lr.message?.threadId;
      if (typeof threadId !== 'string' || threadId.length === 0) continue;
      seen.add(threadId);
    }
  }
  return Array.from(seen);
}
