// Proxy IP / UA labelling for pixel hits.
//
// Google's image proxy ranges are sourced from the published
// `_spf.google.com` SPF chain (resolved at install time and pasted in
// here as a static constant; refresh on dependency updates).
//
// Apple Private Relay / Apple Mail Privacy Protection and Microsoft
// Outlook prefetch ranges drift more often and are partially
// undocumented; for those, fall back to User-Agent heuristics.

export type ProxyLabel = 'google' | 'apple_mpp' | 'ms_prefetch';

// IPv4 CIDRs that Google publishes via _spf.google.com → _netblocks*.
// Last resolved 2026-05-01 (refresh on dependency updates). The list
// is intentionally over-broad; some entries are general Google
// outbound, not just GoogleImageProxy. Tagging a hit as `google`
// means "via a Google IP" which is the right behaviour for the
// dashboard's "via Google proxy" badge.
const GOOGLE_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> =
  Object.freeze(
    [
      // _netblocks.google.com (the historically dominant /16s).
      '35.190.247.0/24',
      '64.233.160.0/19',
      '66.102.0.0/20',
      '66.249.80.0/20',
      '72.14.192.0/18',
      '74.125.0.0/16',
      '108.177.8.0/21',
      '173.194.0.0/16',
      '209.85.128.0/17',
      '216.58.192.0/19',
      '216.239.32.0/19',
      // _netblocks2.google.com.
      '172.217.0.0/19',
      '172.217.32.0/20',
      '172.217.128.0/19',
      '172.217.160.0/20',
      '172.217.192.0/19',
      '172.253.56.0/21',
      '172.253.112.0/20',
      // _netblocks3.google.com.
      '142.250.0.0/15',
    ].map((cidr) => parseIpv4Cidr(cidr)) as ReadonlyArray<readonly [number, number]>,
  );

function parseIpv4Cidr(cidr: string): readonly [number, number] {
  const [addr, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (
    !addr ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    throw new Error(`bad cidr: ${cidr}`);
  }
  const ip = parseIpv4(addr);
  if (ip === null) {
    throw new Error(`bad cidr ip: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return [((ip & mask) >>> 0), mask] as const;
}

function parseIpv4(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// IPv6 is intentionally out of scope for Google CIDR matching - the
// SPF chain advertises IPv6 too but the proxy traffic of interest
// (Gmail's image proxy) has historically been IPv4-only. Apple Private
// Relay traffic that does use IPv6 is caught by the UA heuristic
// below.
export function lookupProxyLabel(ip: string | null | undefined): ProxyLabel | null {
  if (!ip) return null;
  const v4 = parseIpv4(ip);
  if (v4 === null) return null;
  for (const [base, mask] of GOOGLE_IPV4_CIDRS) {
    if ((v4 & mask) >>> 0 === base) {
      return 'google';
    }
  }
  return null;
}

// User-Agent heuristics for proxies that don't expose a stable CIDR
// list (or whose list drifts faster than we want to track).
//
// - Apple's Mail Privacy Protection prefetch fleet identifies itself
//   as `ApplePushService/...` on a subset of clients.
// - Microsoft Outlook's Safe Links / link-prefetch fleet sends
//   `ms-office` or `Microsoft Outlook` in the UA.
const APPLE_MPP_UA = /\bApplePushService\b/i;
const MS_PREFETCH_UA = /\b(ms-office|Microsoft Outlook|MSOFFICE)\b/i;

export function lookupProxyLabelFromUA(
  ua: string | null | undefined,
): ProxyLabel | null {
  if (!ua) return null;
  if (APPLE_MPP_UA.test(ua)) return 'apple_mpp';
  if (MS_PREFETCH_UA.test(ua)) return 'ms_prefetch';
  return null;
}
