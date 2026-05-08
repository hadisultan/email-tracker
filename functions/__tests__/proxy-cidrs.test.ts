import { describe, expect, it } from 'vitest';
import {
  lookupProxyLabel,
  lookupProxyLabelFromUA,
} from '../lib/proxy-cidrs.js';

describe('lookupProxyLabel (IPv4 CIDR)', () => {
  it('returns "google" for an IP inside 66.249.80.0/20', () => {
    expect(lookupProxyLabel('66.249.84.42')).toBe('google');
  });

  it('returns "google" for an IP inside 142.250.0.0/15', () => {
    expect(lookupProxyLabel('142.251.5.1')).toBe('google');
  });

  it('returns null for a non-Google public IP', () => {
    expect(lookupProxyLabel('8.8.8.8')).toBeNull();
  });

  it('returns null for an RFC1918 IP', () => {
    expect(lookupProxyLabel('192.168.1.1')).toBeNull();
  });

  it('returns null for an empty / null / undefined IP', () => {
    expect(lookupProxyLabel(null)).toBeNull();
    expect(lookupProxyLabel(undefined)).toBeNull();
    expect(lookupProxyLabel('')).toBeNull();
  });

  it('returns null for an IPv6 address (out of scope)', () => {
    expect(lookupProxyLabel('2607:f8b0:4004::1')).toBeNull();
  });

  it('returns null for a malformed IPv4 string', () => {
    expect(lookupProxyLabel('not-an-ip')).toBeNull();
    expect(lookupProxyLabel('999.0.0.1')).toBeNull();
    expect(lookupProxyLabel('1.2.3')).toBeNull();
  });
});

describe('lookupProxyLabelFromUA', () => {
  it('returns "apple_mpp" for an ApplePushService UA', () => {
    expect(
      lookupProxyLabelFromUA('Mozilla/5.0 ApplePushService/2.0 (iPhone)'),
    ).toBe('apple_mpp');
  });

  it('returns "ms_prefetch" for ms-office', () => {
    expect(
      lookupProxyLabelFromUA('Mozilla/4.0 (compatible; ms-office; MSOffice 16)'),
    ).toBe('ms_prefetch');
  });

  it('returns "ms_prefetch" for Microsoft Outlook UA', () => {
    expect(
      lookupProxyLabelFromUA('Microsoft Outlook 16.0'),
    ).toBe('ms_prefetch');
  });

  it('returns null for a vanilla Chrome UA', () => {
    expect(
      lookupProxyLabelFromUA(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0',
      ),
    ).toBeNull();
  });

  it('returns null for null / undefined / empty UA', () => {
    expect(lookupProxyLabelFromUA(null)).toBeNull();
    expect(lookupProxyLabelFromUA(undefined)).toBeNull();
    expect(lookupProxyLabelFromUA('')).toBeNull();
  });
});
