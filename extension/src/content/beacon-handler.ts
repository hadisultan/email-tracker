// Pure throttle logic for the self-view beacon. Keeping this isolated
// from the DOM means the orchestrator can unit-test the throttle
// behavior without simulating Gmail navigation.
//
// The state is a plain `Record<threadId, lastBeaconedAtMs>`. Keeping it
// as a record (not a Map) makes it trivially serializable for tests and
// keeps the function fully pure.

export const SELF_VIEW_THROTTLE_MS = 5_000;

export interface ShouldBeaconInput {
  threadId: string;
  lastBeaconedAt: Record<string, number>;
  now: number;
  throttleMs?: number;
}

export function shouldBeacon(input: ShouldBeaconInput): boolean {
  const throttle = input.throttleMs ?? SELF_VIEW_THROTTLE_MS;
  const last = input.lastBeaconedAt[input.threadId];
  if (last === undefined) return true;
  return input.now - last >= throttle;
}
