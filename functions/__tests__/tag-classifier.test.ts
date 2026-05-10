import { describe, expect, it } from 'vitest';
import {
  classifyHit,
  type RecentBeacon,
} from '../lib/tag-classifier.js';

const sentAt = new Date('2026-05-08T10:00:00Z');

function hitAt(offsetMs: number): Date {
  return new Date(sentAt.getTime() + offsetMs);
}

function beacon(offsetMsBeforeHit: number, threadId = 'thread-A'): RecentBeacon {
  return {
    gmail_thread_id: threadId,
    received_at: new Date(hitAt(60_000).getTime() - offsetMsBeforeHit),
  };
}

describe('classifyHit', () => {
  it('returns "none" by default', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(60_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: null,
        ua: 'Mozilla/5.0 (Macintosh)',
      }),
    ).toBe('none');
  });

  it('returns "likely_prefetch" when hit lands within 10s of sentAt', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(3_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: null,
        ua: 'Mozilla/5.0',
      }),
    ).toBe('likely_prefetch');
  });

  it('does NOT return "likely_prefetch" at 10s exactly (boundary)', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(10_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: null,
        ua: 'Mozilla/5.0',
      }),
    ).toBe('none');
  });

  it('returns "self_view_desktop" when a beacon for the same thread arrived in the last 5min', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(60_000),
        threadId: 'thread-A',
        recentBeacons: [beacon(30_000)],
        proxyLabel: null,
        ua: 'Mozilla/5.0',
      }),
    ).toBe('self_view_desktop');
  });

  it('ignores beacons for a different thread', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(60_000),
        threadId: 'thread-A',
        recentBeacons: [beacon(30_000, 'thread-B')],
        proxyLabel: null,
        ua: 'Mozilla/5.0',
      }),
    ).toBe('none');
  });

  it('ignores beacons older than 5min', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(60_000),
        threadId: 'thread-A',
        recentBeacons: [beacon(6 * 60_000)],
        proxyLabel: null,
        ua: 'Mozilla/5.0',
      }),
    ).toBe('none');
  });

  it('keeps Apple MPP hits as "none" even when other rules would match', () => {
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(3_000),
        threadId: 'thread-A',
        recentBeacons: [beacon(30_000)],
        proxyLabel: 'apple_mpp',
        ua: 'ApplePushService/2.0',
      }),
    ).toBe('none');
  });

  it('tags proxy_label="google" hits within 60s of send as "likely_prefetch"', () => {
    // Gmail's image proxy fires at delivery (~+15s scan pass and ~+25-50s
    // follow-up). These are not recipient opens.
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(15_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: 'google',
        ua: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)',
      }),
    ).toBe('likely_prefetch');
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(50_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: 'google',
        ua: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)',
      }),
    ).toBe('likely_prefetch');
  });

  it('does NOT tag proxy_label="google" hits as "likely_prefetch" past 60s', () => {
    // Genuine recipient opens through Gmail's proxy can occur later; we
    // don't want to suppress those. They fall through to beacon/none rules.
    expect(
      classifyHit({
        sentAt,
        hitAt: hitAt(120_000),
        threadId: 'thread-A',
        recentBeacons: [],
        proxyLabel: 'google',
        ua: 'Mozilla/5.0',
      }),
    ).toBe('none');
  });

  it('handles a null sentAt without crashing', () => {
    expect(
      classifyHit({
        sentAt: null,
        hitAt: hitAt(60_000),
        threadId: null,
        recentBeacons: [],
        proxyLabel: null,
        ua: '',
      }),
    ).toBe('none');
  });
});
