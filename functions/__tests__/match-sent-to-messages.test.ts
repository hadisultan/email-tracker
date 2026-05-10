import { describe, expect, it } from 'vitest';
import {
  matchSentToMessages,
  type CandidateMessage,
  type SentMetadata,
} from '../lib/match-sent-to-messages.js';

const T0 = Date.parse('2026-05-10T06:39:47.447Z');

function candidate(id: string, subject: string, sentAtOffsetMs = 0): CandidateMessage {
  return {
    id,
    subject,
    sentAt: new Date(T0 + sentAtOffsetMs).toISOString(),
  };
}

function sent(
  messageId: string,
  threadId: string,
  subject: string,
  internalOffsetMs = 0,
): SentMetadata {
  return {
    messageId,
    threadId,
    subject,
    internalDateMs: T0 + internalOffsetMs,
  };
}

describe('matchSentToMessages', () => {
  it('returns [] when either side is empty', () => {
    expect(matchSentToMessages([], [sent('gm-1', 'th-1', 's')])).toEqual([]);
    expect(matchSentToMessages([candidate('m-1', 's')], [])).toEqual([]);
    expect(matchSentToMessages([], [])).toEqual([]);
  });

  it('matches a single candidate to a single Gmail send by exact subject + close internalDate', () => {
    const updates = matchSentToMessages(
      [candidate('m-1', 'tracker test 16', 0)],
      [sent('gm-A', 'th-A', 'tracker test 16', 1500)],
    );
    expect(updates).toEqual([
      { candidateId: 'm-1', gmailMessageId: 'gm-A', gmailThreadId: 'th-A' },
    ]);
  });

  it('rejects matches outside the ±5min window', () => {
    const updates = matchSentToMessages(
      [candidate('m-1', 'tracker test 16', 0)],
      [sent('gm-A', 'th-A', 'tracker test 16', 6 * 60_000)],
    );
    expect(updates).toEqual([]);
  });

  it('rejects subject mismatches even within the time window', () => {
    const updates = matchSentToMessages(
      [candidate('m-1', 'tracker test 16', 0)],
      [sent('gm-A', 'th-A', 'tracker test 17', 1000)],
    );
    expect(updates).toEqual([]);
  });

  it('picks the closest internalDate when multiple Gmail sends share the subject', () => {
    const updates = matchSentToMessages(
      [candidate('m-1', 'newsletter', 0)],
      [
        sent('gm-far', 'th-far', 'newsletter', 4 * 60_000),
        sent('gm-near', 'th-near', 'newsletter', 2_000),
        sent('gm-mid', 'th-mid', 'newsletter', 60_000),
      ],
    );
    expect(updates).toEqual([
      { candidateId: 'm-1', gmailMessageId: 'gm-near', gmailThreadId: 'th-near' },
    ]);
  });

  it('does not double-claim a Gmail send when two candidates share the same subject', () => {
    // Two of our messages share a subject; only one Gmail send exists.
    // The closer match wins; the other stays NULL until next cycle.
    const updates = matchSentToMessages(
      [
        candidate('m-old', 'newsletter', 0),
        candidate('m-new', 'newsletter', 30_000),
      ],
      [sent('gm-A', 'th-A', 'newsletter', 31_000)],
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      candidateId: 'm-new',
      gmailMessageId: 'gm-A',
      gmailThreadId: 'th-A',
    });
  });

  it('pairs each candidate to its own Gmail send when subjects collide but two sends exist', () => {
    const updates = matchSentToMessages(
      [
        candidate('m-old', 'duplicate subject', 0),
        candidate('m-new', 'duplicate subject', 60_000),
      ],
      [
        sent('gm-1', 'th-1', 'duplicate subject', 2_000),
        sent('gm-2', 'th-2', 'duplicate subject', 62_000),
      ],
    );
    // Greedy by closest delta. Both sends pair within 2s of their
    // closest candidate (gm-1↔m-old, gm-2↔m-new), so each side claims
    // its closer counterpart regardless of iteration order.
    expect(updates).toHaveLength(2);
    expect(new Set(updates)).toEqual(
      new Set([
        { candidateId: 'm-old', gmailMessageId: 'gm-1', gmailThreadId: 'th-1' },
        { candidateId: 'm-new', gmailMessageId: 'gm-2', gmailThreadId: 'th-2' },
      ]),
    );
  });

  it('skips candidates whose sentAt cannot be parsed', () => {
    const updates = matchSentToMessages(
      [
        { id: 'm-bad', subject: 's', sentAt: 'not-a-date' },
        candidate('m-ok', 's', 0),
      ],
      [sent('gm-1', 'th-1', 's', 1000)],
    );
    expect(updates).toEqual([
      { candidateId: 'm-ok', gmailMessageId: 'gm-1', gmailThreadId: 'th-1' },
    ]);
  });

  it('is case-sensitive on subject (exact match required)', () => {
    const updates = matchSentToMessages(
      [candidate('m-1', 'Tracker Test 16', 0)],
      [sent('gm-1', 'th-1', 'tracker test 16', 0)],
    );
    expect(updates).toEqual([]);
  });
});
