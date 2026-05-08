// Tracking-token mint.
//
// Returns a 128-bit base64url-encoded random string used as the public
// identifier in `/pixel/<token>`. The same string is stored verbatim in
// `messages.token` (UNIQUE) — unlike service tokens, tracking tokens are
// not hashed, because they have to round-trip through the recipient's
// email client and back via an HTTP GET.
//
// 128 bits is plenty: even at 1M sends the chance of a collision is
// negligible, and the schema's UNIQUE constraint catches it if not.

import { randomBase64Url } from './auth.js';

export function mintTrackingToken(): string {
  return randomBase64Url(128);
}
