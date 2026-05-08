import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withCors, corsHeadersFor } from '../lib/cors.js';
import { respondJson } from '../lib/respond.js';

const DASHBOARD = 'http://localhost:5173';
const EXTENSION = 'chrome-extension://abc123def456';

const prevDashboard = process.env.DASHBOARD_ORIGIN;
const prevExtension = process.env.EXTENSION_ORIGIN;

beforeEach(() => {
  process.env.DASHBOARD_ORIGIN = DASHBOARD;
  process.env.EXTENSION_ORIGIN = EXTENSION;
});

afterEach(() => {
  if (prevDashboard === undefined) delete process.env.DASHBOARD_ORIGIN;
  else process.env.DASHBOARD_ORIGIN = prevDashboard;
  if (prevExtension === undefined) delete process.env.EXTENSION_ORIGIN;
  else process.env.EXTENSION_ORIGIN = prevExtension;
});

function preflight(origin: string | null): Request {
  const headers: Record<string, string> = { 'access-control-request-method': 'POST' };
  if (origin) headers['origin'] = origin;
  return new Request('http://localhost/api/whatever', {
    method: 'OPTIONS',
    headers,
  });
}

const fakeContext = {} as never;

const handlerOk = withCors((_req: Request) => respondJson({ ok: true }));

describe('withCors preflight', () => {
  it('returns 204 with allow-headers and max-age for an allowed origin', async () => {
    const res = await handlerOk(preflight(DASHBOARD), fakeContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Idempotency-Key/);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('also allows the EXTENSION_ORIGIN', async () => {
    const res = await handlerOk(preflight(EXTENSION), fakeContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION);
  });

  it('returns 403 for a disallowed origin', async () => {
    const res = await handlerOk(preflight('https://evil.example.com'), fakeContext);
    expect(res.status).toBe(403);
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('supports comma-separated origin lists per env var', async () => {
    process.env.DASHBOARD_ORIGIN = `${DASHBOARD},https://email-tracker.example.com`;
    const res = await handlerOk(preflight('https://email-tracker.example.com'), fakeContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://email-tracker.example.com');
  });
});

describe('withCors actual response', () => {
  it('adds Allow-Origin to non-preflight responses for allowed origins', async () => {
    const req = new Request('http://localhost/api/whatever', {
      method: 'POST',
      headers: { origin: DASHBOARD },
    });
    const res = await handlerOk(req, fakeContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(DASHBOARD);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not add Allow-Origin for disallowed origins (browser blocks the response)', async () => {
    const req = new Request('http://localhost/api/whatever', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    const res = await handlerOk(req, fakeContext);
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
  });
});

describe('corsHeadersFor', () => {
  it('returns empty when origin missing', () => {
    const req = new Request('http://localhost/api/x', { method: 'POST' });
    expect(corsHeadersFor(req)).toEqual({});
  });
});
