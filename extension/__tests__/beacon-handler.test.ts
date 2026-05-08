import { describe, expect, it } from 'vitest';
import {
  shouldBeacon,
  SELF_VIEW_THROTTLE_MS,
} from '../src/content/beacon-handler.js';

describe('shouldBeacon', () => {
  it('returns true when the thread has never been beaconed', () => {
    expect(
      shouldBeacon({ threadId: 't1', lastBeaconedAt: {}, now: 1_000 }),
    ).toBe(true);
  });

  it('returns true when the prior beacon is exactly throttleMs ago', () => {
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt: { t1: 1_000 },
        now: 1_000 + SELF_VIEW_THROTTLE_MS,
      }),
    ).toBe(true);
  });

  it('returns true when the prior beacon is comfortably outside the window', () => {
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt: { t1: 1_000 },
        now: 1_000 + 6_000,
      }),
    ).toBe(true);
  });

  it('returns false when the prior beacon is inside the throttle window', () => {
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt: { t1: 1_000 },
        now: 1_000 + 2_000,
      }),
    ).toBe(false);
  });

  it('returns false at boundary minus 1ms (strict greater-or-equal)', () => {
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt: { t1: 1_000 },
        now: 1_000 + SELF_VIEW_THROTTLE_MS - 1,
      }),
    ).toBe(false);
  });

  it('different threads do not share throttle state', () => {
    const lastBeaconedAt = { t1: 1_000 };
    expect(
      shouldBeacon({ threadId: 't2', lastBeaconedAt, now: 1_500 }),
    ).toBe(true);
    expect(
      shouldBeacon({ threadId: 't1', lastBeaconedAt, now: 1_500 }),
    ).toBe(false);
  });

  it('respects an overridden throttleMs', () => {
    const lastBeaconedAt = { t1: 1_000 };
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt,
        now: 1_500,
        throttleMs: 100,
      }),
    ).toBe(true);
    expect(
      shouldBeacon({
        threadId: 't1',
        lastBeaconedAt,
        now: 1_050,
        throttleMs: 100,
      }),
    ).toBe(false);
  });

  it('default throttle is 5 seconds', () => {
    expect(SELF_VIEW_THROTTLE_MS).toBe(5_000);
  });
});
