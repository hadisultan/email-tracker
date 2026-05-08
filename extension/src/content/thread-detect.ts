// Detect when the user is viewing one of their own sent threads on
// desktop Gmail. This is the trigger for posting a self-view beacon to
// the backend so any concurrent pixel hit on the same thread can be
// tagged `self_view_desktop`.
//
// Detection strategy:
//   - Gmail uses fragment-based routing: the URL hash encodes the
//     current view, e.g. `#sent/<thread-id>` when a thread inside the
//     Sent label is open.
//   - We treat `#sent/<thread-id>` as a positive match. We deliberately
//     do NOT match `#inbox/<thread-id>` because the user could be
//     viewing an incoming reply on a thread they previously sent — the
//     plan calls this out as a false-positive class to avoid.
//   - The backend `/api/beacon` validates the thread belongs to the
//     user's own messages and silently drops foreign threads, so an
//     occasional over-eager match is bounded to "extra round trip" and
//     never to "wrong suppression".
//
// All exports are pure: they take `Location` and (optionally) `Document`
// inputs and return their result without touching globals.

export interface DetectedThread {
  threadId: string;
}

// Sent-label URLs Gmail uses. Multiple aliases are accepted because
// Gmail occasionally re-skins these (`#sent/<id>` is the historical
// form; `#label/Sent/<id>` shows up in some account configurations).
const SENT_HASH_PATTERNS: readonly RegExp[] = [
  /^#sent\/([^/?]+)$/i,
  /^#label\/sent\/([^/?]+)$/i,
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
