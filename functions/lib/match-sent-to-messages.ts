// Pure matcher: pair our `messages` rows that have `gmail_thread_id IS
// NULL` against Gmail send metadata fetched via `users.messages.list`
// + `users.messages.get`.
//
// Why the matching is needed: at compose time the extension can't
// know the thread_id Gmail will assign (it's a server-side decision
// taken when Gmail accepts the send). The mint endpoint stores
// `gmail_thread_id = NULL`. Without backfilling, both `self_view_*`
// classification paths are dead — the beacon's ownership check fails,
// and the poller's history-list JOIN against `messages.gmail_thread_id`
// matches nothing.
//
// Matching strategy: pair candidates to Gmail sends by exact subject
// match within a ±5min internalDate window. Subject-only matching is
// fragile (subjects collide across replies, periodic newsletters,
// etc.) but the time window collapses the false-positive rate for
// fresh sends — the user just sent the message, so the closest
// internalDate within a few minutes is overwhelmingly the right one.
// When multiple Gmail messages match the same candidate, pick the one
// with internalDate closest to our `sent_at`.

const SENT_AT_WINDOW_MS = 5 * 60_000;

export interface CandidateMessage {
  id: string;
  subject: string;
  // ISO timestamp.
  sentAt: string;
}

export interface SentMetadata {
  // Gmail message id (stable, immutable).
  messageId: string;
  // Gmail thread id (stable, immutable).
  threadId: string;
  subject: string;
  // Unix epoch ms.
  internalDateMs: number;
}

export interface BackfillUpdate {
  candidateId: string;
  gmailMessageId: string;
  gmailThreadId: string;
}

export function matchSentToMessages(
  candidates: ReadonlyArray<CandidateMessage>,
  sent: ReadonlyArray<SentMetadata>,
): BackfillUpdate[] {
  if (candidates.length === 0 || sent.length === 0) return [];

  // Greedy bipartite match: enumerate every (candidate, sent) pair
  // that's both subject-equal and inside the time window, sort by
  // |delta| ascending, then claim pairs in order while skipping
  // already-claimed sides. This minimizes total error vs the
  // "older candidate gets first pick" heuristic, which mis-pairs
  // when a more-recent candidate is the closer match for a Gmail
  // send.
  interface Pair {
    candidate: CandidateMessage;
    sent: SentMetadata;
    delta: number;
  }
  const pairs: Pair[] = [];
  for (const c of candidates) {
    const sentAtMs = new Date(c.sentAt).getTime();
    if (!Number.isFinite(sentAtMs)) continue;
    for (const s of sent) {
      if (s.subject !== c.subject) continue;
      const delta = Math.abs(s.internalDateMs - sentAtMs);
      if (delta >= SENT_AT_WINDOW_MS) continue;
      pairs.push({ candidate: c, sent: s, delta });
    }
  }

  pairs.sort((a, b) => {
    if (a.delta !== b.delta) return a.delta - b.delta;
    // Deterministic tiebreak so two equally-close matches resolve
    // the same way across runs.
    const candCmp = a.candidate.id.localeCompare(b.candidate.id);
    if (candCmp !== 0) return candCmp;
    return a.sent.messageId.localeCompare(b.sent.messageId);
  });

  const claimedSent = new Set<string>();
  const claimedCand = new Set<string>();
  const updates: BackfillUpdate[] = [];
  for (const p of pairs) {
    if (claimedSent.has(p.sent.messageId)) continue;
    if (claimedCand.has(p.candidate.id)) continue;
    claimedSent.add(p.sent.messageId);
    claimedCand.add(p.candidate.id);
    updates.push({
      candidateId: p.candidate.id,
      gmailMessageId: p.sent.messageId,
      gmailThreadId: p.sent.threadId,
    });
  }

  return updates;
}

export const _internals = {
  SENT_AT_WINDOW_MS,
};
