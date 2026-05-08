import { describe, expect, it } from 'vitest';
import { respondError, respondJson, respondNoContent } from '../lib/respond.js';

describe('respondError', () => {
  it('returns the standard error envelope shape', async () => {
    const res = respondError('bad_request', 'no good', 400);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'bad_request', message: 'no good' } });
  });

  it('includes optional details when provided', async () => {
    const res = respondError('bad_request', 'no good', 400, { field: 'recipients' });
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body).toEqual({ error: { code: 'bad_request', message: 'no good', details: { field: 'recipients' } } });
  });

  it('omits the details key entirely when not passed', async () => {
    const res = respondError('not_found', 'gone', 404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
  });
});

describe('respondJson', () => {
  it('serializes the body and defaults to status 200', async () => {
    const res = respondJson({ ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('respects an explicit status code', () => {
    const res = respondJson({ created: 1 }, 201);
    expect(res.status).toBe(201);
  });
});

describe('respondNoContent', () => {
  it('returns 204 with no body', async () => {
    const res = respondNoContent();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});
