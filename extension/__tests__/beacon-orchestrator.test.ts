// Self-view beacon orchestration in gmail.ts. We test:
//   - maybeBeaconCurrentView: directly, against location.hash fixtures.
//   - startObserver: hooks a hashchange listener that fires the same
//     code path; stopObserver tears it down.
//
// The orchestrator module is loaded with `vi.resetModules()` before
// each test so the module-scoped `lastBeaconedAt` and `observer`
// singletons start fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  // Reset URL hash for each test.
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname);
  }
});

afterEach(async () => {
  const { stopObserver } = await import('../src/content/gmail.js');
  stopObserver();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function loadOrchestrator() {
  return import('../src/content/gmail.js');
}

function setHash(hash: string): void {
  history.replaceState(null, '', hash);
}

describe('maybeBeaconCurrentView', () => {
  it('does nothing when not on a sent-thread URL', async () => {
    setHash('#inbox/abc');
    const { _internals } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 });
    expect(beaconFn).not.toHaveBeenCalled();
  });

  it('fires beacon when URL is #sent/<thread-id> on first visit', async () => {
    setHash('#sent/THREAD123');
    const { _internals } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 });
    expect(beaconFn).toHaveBeenCalledTimes(1);
    expect(beaconFn).toHaveBeenCalledWith('THREAD123');
    expect(_internals.lastBeaconedAt['THREAD123']).toBe(1_000);
  });

  it('does not fire a second beacon for the same thread inside the throttle window', async () => {
    setHash('#sent/THREAD123');
    const { _internals } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 });
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 3_000 });
    expect(beaconFn).toHaveBeenCalledTimes(1);
  });

  it('fires again once the throttle window has elapsed', async () => {
    setHash('#sent/THREAD123');
    const { _internals } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 });
    await _internals.maybeBeaconCurrentView({ beaconFn, now: () => 7_000 });
    expect(beaconFn).toHaveBeenCalledTimes(2);
  });

  it('records the timestamp BEFORE awaiting beacon (rapid hashchange storm guard)', async () => {
    setHash('#sent/THREAD123');
    const { _internals } = await loadOrchestrator();
    let resolveBeacon: (() => void) | undefined;
    const beaconFn = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveBeacon = r;
        }),
    );

    const p1 = _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 });
    // Without awaiting p1, fire a second invocation. The throttle
    // record should already be set, so the second call should noop.
    const p2 = _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_001 });
    await p2;
    expect(beaconFn).toHaveBeenCalledTimes(1);
    resolveBeacon?.();
    await p1;
  });

  it('logs a warning but does not throw when beacon rejects', async () => {
    setHash('#sent/THREAD123');
    const { _internals } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => {
      throw new Error('network down');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      _internals.maybeBeaconCurrentView({ beaconFn, now: () => 1_000 }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0]?.[0];
    expect(typeof logged).toBe('string');
    expect(logged as string).toContain('self-view-beacon');
    expect(logged as string).toContain('network down');
  });
});

describe('startObserver / hashchange', () => {
  it('fires an initial beacon when started on a sent-thread URL', async () => {
    setHash('#sent/INITIAL');
    const { startObserver } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    startObserver({ beaconFn, now: () => 1_000 });
    // maybeBeaconCurrentView is async; allow microtasks to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).toHaveBeenCalledTimes(1);
    expect(beaconFn).toHaveBeenCalledWith('INITIAL');
  });

  it('does not fire on initial start when not on a sent thread', async () => {
    setHash('#inbox/X');
    const { startObserver } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    startObserver({ beaconFn, now: () => 1_000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).not.toHaveBeenCalled();
  });

  it('hashchange to #sent/<id> fires a beacon', async () => {
    setHash('#inbox');
    const { startObserver } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    let n = 1_000;
    startObserver({ beaconFn, now: () => n });
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).not.toHaveBeenCalled();

    n = 2_000;
    setHash('#sent/AAA');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).toHaveBeenCalledTimes(1);
    expect(beaconFn).toHaveBeenCalledWith('AAA');
  });

  it('stopObserver tears down the hashchange listener', async () => {
    setHash('#inbox');
    const { startObserver, stopObserver } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    startObserver({ beaconFn, now: () => 1_000 });
    stopObserver();

    setHash('#sent/AAA');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).not.toHaveBeenCalled();
  });

  it('startObserver is idempotent — re-calling does not double-attach the listener', async () => {
    setHash('#inbox');
    const { startObserver } = await loadOrchestrator();
    const beaconFn = vi.fn(async () => undefined);
    startObserver({ beaconFn, now: () => 1_000 });
    startObserver({ beaconFn, now: () => 1_000 });

    setHash('#sent/AAA');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconFn).toHaveBeenCalledTimes(1);
  });
});
