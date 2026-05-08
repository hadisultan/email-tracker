import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  computePollSignature,
  generatePairingCode,
  generateServiceToken,
  normalizePairingCode,
  ownerAllowlist,
  randomBase32,
  randomBase64Url,
  requirePollHmac,
  requireServiceToken,
  requireUserJwt,
  sha256Hex,
} from '../lib/auth.js';
import {
  _resetServiceRoleClientForTests,
  _setAuthClientForTests,
} from '../lib/supabase.js';
import { LOCAL_DB_URL, SEED_USER_ID } from './db/helpers.js';

// Real local Supabase (for the requireServiceToken test) + env defaults.
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY = 'test-stub-service-role-key';

process.env.SUPABASE_URL ??= LOCAL_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= LOCAL_SERVICE_ROLE_KEY;
process.env.SUPABASE_DB_URL ??= LOCAL_DB_URL;

let sql: Sql;

beforeAll(() => {
  sql = postgres(process.env.SUPABASE_DB_URL!, { onnotice: () => {}, max: 4 });
});

afterEach(async () => {
  await sql`DELETE FROM public.service_tokens WHERE user_id = ${SEED_USER_ID}`;
  _setAuthClientForTests(null);
  _resetServiceRoleClientForTests();
});

// === crypto helpers ===

describe('sha256Hex', () => {
  it('returns 64 lowercase hex chars', () => {
    const h = sha256Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('randomBase32', () => {
  it('returns the requested number of base32 chars', () => {
    const code = randomBase32(80);
    expect(code).toMatch(/^[A-Z2-7]{16}$/);
  });

  it('rejects non-multiple-of-5 bit lengths', () => {
    expect(() => randomBase32(81)).toThrow();
  });
});

describe('randomBase64Url', () => {
  it('returns base64url chars only', () => {
    const t = randomBase64Url(128);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(22);
  });
});

describe('generatePairingCode', () => {
  it('is 16 base32 chars in 4-char groups', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it('successive codes differ', () => {
    expect(generatePairingCode()).not.toBe(generatePairingCode());
  });
});

describe('normalizePairingCode', () => {
  it('strips hyphens and uppercases', () => {
    expect(normalizePairingCode('abcd-efgh-ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
  });
  it('strips whitespace', () => {
    expect(normalizePairingCode(' abcd efgh ijkl mnop ')).toBe('ABCDEFGHIJKLMNOP');
  });
});

describe('generateServiceToken', () => {
  it('starts with the et_ prefix and is opaque', () => {
    const t = generateServiceToken();
    expect(t).toMatch(/^et_[A-Za-z0-9_-]+$/);
  });
});

// === ownerAllowlist ===

describe('ownerAllowlist', () => {
  const prev = process.env.OWNER_EMAIL_ALLOWLIST;
  afterEach(() => {
    if (prev === undefined) delete process.env.OWNER_EMAIL_ALLOWLIST;
    else process.env.OWNER_EMAIL_ALLOWLIST = prev;
  });

  it('parses a comma-separated list and lowercases', () => {
    process.env.OWNER_EMAIL_ALLOWLIST = ' Alice@Example.com , bob@example.com';
    expect(ownerAllowlist()).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('returns empty when unset', () => {
    delete process.env.OWNER_EMAIL_ALLOWLIST;
    expect(ownerAllowlist()).toEqual([]);
  });
});

// === requireUserJwt (mock auth client) ===

const fakeAuthClient = (
  shouldSucceed: boolean,
  user: { id: string; email: string } | null = null,
) =>
  ({
    auth: {
      getUser: async (_jwt: string) =>
        shouldSucceed && user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } },
    },
  } as unknown as Parameters<typeof requireUserJwt>[1]);

function bearerRequest(token: string): Request {
  return new Request('http://localhost/api/whatever', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('requireUserJwt', () => {
  it('returns 401 when Authorization is missing', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST' });
    const result = await requireUserJwt(req, fakeAuthClient(true, { id: 'u', email: 'a@b' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_jwt');
    }
  });

  it('returns 401 when supabase rejects the JWT', async () => {
    const result = await requireUserJwt(bearerRequest('bad'), fakeAuthClient(false));
    expect(result.ok).toBe(false);
  });

  it('returns the user_id and email on success', async () => {
    const result = await requireUserJwt(
      bearerRequest('good'),
      fakeAuthClient(true, { id: SEED_USER_ID, email: 'owner@example.com' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBe(SEED_USER_ID);
      expect(result.data.email).toBe('owner@example.com');
    }
  });

  it('returns 401 when the JWT has no email claim', async () => {
    const result = await requireUserJwt(
      bearerRequest('good'),
      fakeAuthClient(true, { id: SEED_USER_ID, email: '' }),
    );
    expect(result.ok).toBe(false);
  });
});

// === requireServiceToken (real local DB) ===

describe('requireServiceToken', () => {
  it('returns 401 when no Authorization header', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST' });
    const result = await requireServiceToken(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('returns 401 for an unrecognized token', async () => {
    const result = await requireServiceToken(bearerRequest('et_unknown'));
    expect(result.ok).toBe(false);
  });

  it('accepts a token whose sha256 is stored as token_hash', async () => {
    const token = 'et_test-fixed-token';
    const tokenHash = sha256Hex(token);
    await sql`
      INSERT INTO public.service_tokens (user_id, token_hash, label)
      VALUES (${SEED_USER_ID}, ${tokenHash}, 'test')
    `;
    // Direct read to confirm the row landed (also acts as a lightweight
    // commit barrier between the postgres direct connection and the
    // supabase-js HTTP read below).
    const direct = await sql<{ token_hash: string }[]>`
      SELECT token_hash FROM public.service_tokens WHERE token_hash = ${tokenHash}
    `;
    expect(direct.length).toBe(1);

    const result = await requireServiceToken(bearerRequest(token));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.userId).toBe(SEED_USER_ID);
    }
  });

  it('rejects a revoked token', async () => {
    const token = 'et_revoked-token';
    const tokenHash = sha256Hex(token);
    await sql`
      INSERT INTO public.service_tokens (user_id, token_hash, label, revoked_at)
      VALUES (${SEED_USER_ID}, ${tokenHash}, 'test', now())
    `;
    const result = await requireServiceToken(bearerRequest(token));
    expect(result.ok).toBe(false);
  });
});

// === requirePollHmac ===

describe('requirePollHmac', () => {
  const prev = process.env.POLL_HMAC_SECRET;
  beforeEach(() => {
    process.env.POLL_HMAC_SECRET = 'test-secret-xyz';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.POLL_HMAC_SECRET;
    else process.env.POLL_HMAC_SECRET = prev;
  });

  it('returns 401 when X-Signature is missing', async () => {
    const req = new Request('http://localhost/api/gmail-poll', { method: 'POST' });
    const result = await requirePollHmac(req);
    expect(result.ok).toBe(false);
  });

  it('returns 401 when X-Signature does not match', async () => {
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'x-signature': 'deadbeef' },
    });
    const result = await requirePollHmac(req);
    expect(result.ok).toBe(false);
  });

  it('accepts a valid signature for an empty body', async () => {
    const sig = computePollSignature('');
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'x-signature': sig },
    });
    const result = await requirePollHmac(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.rawBody).toBe('');
  });

  it('rejects a signature computed against a different body', async () => {
    const sig = computePollSignature('something-else');
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'x-signature': sig },
      body: '',
    });
    const result = await requirePollHmac(req);
    expect(result.ok).toBe(false);
  });

  it('returns 500 when POLL_HMAC_SECRET is not set', async () => {
    delete process.env.POLL_HMAC_SECRET;
    const req = new Request('http://localhost/api/gmail-poll', {
      method: 'POST',
      headers: { 'x-signature': 'aa' },
    });
    const result = await requirePollHmac(req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });
});
