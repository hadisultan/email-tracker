// Pure pixel-hit tag classifier. Stateless: every input it needs is
// passed in. Same function is used by the pixel handler (Unit 3) and
// the dashboard's hit-replay tooling.
//
// Decision matrix (see plan, "Self-view suppression decision matrix"):
//   1. Apple-MPP-tagged hits stay 'none' (counted as opens, push-
//      notified). The proxy_label is what the dashboard uses to render
//      the "Apple MPP suspected" notice.
//   2. Hit < 10s after sent_at -> 'likely_prefetch'.
//   3. Hit < 5min after a self-view beacon for the same gmail_thread_id
//      -> 'self_view_desktop'.
//   4. Otherwise -> 'none'.
// Mobile self-view classification ('self_view_mobile') happens in the
// poller (Unit 7), not here.

export type PixelTag =
  | 'none'
  | 'likely_prefetch'
  | 'self_view_desktop'
  | 'self_view_mobile';

const PREFETCH_WINDOW_MS = 10_000;
const BEACON_WINDOW_MS = 5 * 60_000;

export interface RecentBeacon {
  gmail_thread_id: string | null;
  received_at: Date;
}

export interface ClassifyHitInput {
  sentAt: Date | null;
  hitAt: Date;
  threadId: string | null;
  recentBeacons: ReadonlyArray<RecentBeacon>;
  proxyLabel: string | null;
  ua: string | null;
}

export function classifyHit(input: ClassifyHitInput): PixelTag {
  // Apple MPP fetches are intentionally counted as opens so the
  // recipient's MPP-driven "open" still surfaces on the dashboard.
  // The proxy_label column carries the "this might be MPP" signal.
  if (input.proxyLabel === 'apple_mpp') return 'none';

  if (input.sentAt) {
    const sinceSendMs = input.hitAt.getTime() - input.sentAt.getTime();
    if (sinceSendMs >= 0 && sinceSendMs < PREFETCH_WINDOW_MS) {
      return 'likely_prefetch';
    }
  }

  if (input.threadId) {
    for (const beacon of input.recentBeacons) {
      if (beacon.gmail_thread_id !== input.threadId) continue;
      const sinceBeaconMs =
        input.hitAt.getTime() - beacon.received_at.getTime();
      if (sinceBeaconMs >= 0 && sinceBeaconMs < BEACON_WINDOW_MS) {
        return 'self_view_desktop';
      }
    }
  }

  return 'none';
}
