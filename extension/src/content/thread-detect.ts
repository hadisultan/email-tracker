// Detect when the user is viewing one of their own sent threads on
// desktop Gmail. This is the trigger for posting a self-view beacon to
// the backend so any concurrent pixel hit on the same thread can be
// tagged `self_view_desktop`.
//
// Detection strategy:
//   - Gmail uses fragment-based routing: the URL hash encodes the
//     current view, e.g. `#sent/<thread-id>` or `#inbox/<thread-id>`
//     when a thread is open.
//   - We match `#sent/<id>`, `#label/sent/<id>`, AND `#inbox/<id>`.
//     Self-sends (sender == one of the recipients, e.g. you mailing
//     yourself) deliver to the inbox, so Gmail surfaces the URL as
//     `#inbox/<id>` — without matching that, we'd never fire a beacon
//     for the most common single-user testing path.
//   - The `#inbox/<id>` match introduces a small false-positive class:
//     a user opens an inbound reply on a thread they previously sent
//     into BEFORE the recipient opens the message, and the recipient's
//     subsequent pixel hit gets tagged `self_view_*` and the push is
//     suppressed. Two reasons this is acceptable:
//     (a) The classifier only counts beacons received within a 5-min
//         window leading up to the hit, so a user who viewed their
//         inbox hours ago doesn't shadow a fresh recipient open.
//     (b) The backend `/api/beacon` endpoint independently validates
//         ownership: only threads that have one of the caller's own
//         messages get persisted, so an `#inbox/<id>` view of a
//         purely-inbound thread (someone else's thread) is silently
//         dropped without recording a beacon.
//
// All exports are pure: they take `Location` and (optionally) `Document`
// inputs and return their result without touching globals.

export interface DetectedThread {
  threadId: string;
}

const SENT_HASH_PATTERNS: readonly RegExp[] = [
  /^#sent\/([^/?]+)$/i,
  /^#label\/sent\/([^/?]+)$/i,
  /^#inbox\/([^/?]+)$/i,
];

export function detectSelfThreadView(
  loc: { hash: string },
): DetectedThread | null {
  const hash = loc.hash;
  if (!hash || hash.length < 2) return null;
  for (const re of SENT_HASH_PATTERNS) {
    const m = re.exec(hash);
    if (m && m[1] && m[1].length > 0) {
      return { threadId: m[1] };
    }
  }
  return null;
}
