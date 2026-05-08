// Auth helpers and middlewares for Netlify functions.
//
// Three auth modes:
//  1. requireUserJwt       — Supabase-issued JWT for the dashboard.
//  2. requireServiceToken  — opaque bearer token for the Chrome extension.
//  3. requirePollHmac      — HMAC-SHA256 over the request body for cron.
//
// Token storage uses SHA256 (not bcrypt) because:
//  - The DB schema's column comment says "sha256(token)".
//  - Tokens are 128-bit-random so brute-force is infeasible regardless of
//    hash choice.
//  - Lookup is by-hash on every API request; SHA256 is O(1) via the unique
//    index, bcrypt would require an O(n) compare across active tokens.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type SupabaseClient } from '@supabase/supabase-js';
import { authClient, serviceRoleClient } from './supabase.js';
import { respondError } from './respond.js';

// === Crypto helpers ===

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomBase64Url(bits: number): string {
  if (bits % 8 !== 0) throw new Error('bits must be a multiple of 8');
  return randomBytes(bits / 8).toString('base64url');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomBase32(bits: number): string {
  if (bits % 5 !== 0) throw new Error('bits must be a multiple of 5');
  const bytes = randomBytes(Math.ceil(bits / 8));
  let out = '';
  let buffer = 0;
  let bitsInBuffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5 && out.length < bits / 5) {
      bitsInBuffer -= 5;
      out += BASE32_ALPHABET[(buffer >> bitsInBuffer) & 0x1f];
    }
  }
  return out;
}

// Pairing code: 80 bits → 16 base32 chars, formatted in groups of 4 for paste.
export function generatePairingCode(): string {
  const raw = randomBase32(80);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// Service token: 128 bits → 22 base64url chars, prefixed for human ID.
export function generateServiceToken(): string {
  return `et_${randomBase64Url(128)}`;
}

// === Auth result types ===

export interface AuthOk<T> {
  ok: true;
  data: T;
}
export interface AuthFail {
  ok: false;
  response: Response;
}
export type AuthResult<T> = AuthOk<T> | AuthFail;

function fail(response: Response): AuthFail {
  return { ok: false, response };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

// === requireUserJwt ===

export interface UserJwtData {
  userId: string;
  email: string;
}

export async function requireUserJwt(
  req: Request,
  client?: SupabaseClient,
): Promise<AuthResult<UserJwtData>> {
  const jwt = bearerToken(req);
  if (!jwt) {
    return fail(respondError('invalid_jwt', 'missing Authorization bearer token', 401));
  }
  const sb = client ?? authClient();
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) {
    return fail(respondError('invalid_jwt', 'jwt verification failed', 401));
  }
  const email = data.user.email ?? '';
  if (!email) {
    return fail(respondError('invalid_jwt', 'jwt has no email claim', 401));
  }
  return { ok: true, data: { userId: data.user.id, email } };
}

// === Owner allowlist ===

export function ownerAllowlist(): string[] {
  const raw = process.env.OWNER_EMAIL_ALLOWLIST ?? '';
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isOwnerEmail(email: string): boolean {
  const allow = ownerAllowlist();
  if (allow.length === 0) return false;
  return allow.includes(email.toLowerCase());
}

// === requireServiceToken ===

export interface ServiceTokenData {
  userId: string;
  tokenId: string;
}

export async function requireServiceToken(
  req: Request,
  client?: SupabaseClient,
): Promise<AuthResult<ServiceTokenData>> {
  const token = bearerToken(req);
  if (!token) {
    return fail(respondError('invalid_token', 'missing Authorization bearer token', 401));
  }
  // Service-role client (DB access) — distinct from `authClient()` which is
  // for `auth.getUser()` calls and is overridable in tests.
  const sb = client ?? serviceRoleClient();
  const tokenHash = sha256Hex(token);
  const { data, error } = await sb
    .from('service_tokens')
    .select('id, user_id, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error || !data || data.revoked_at !== null) {
    return fail(respondError('invalid_token', 'service token is invalid or revoked', 401));
  }
  // Best-effort touch of last_used_at; failures here don't block the request.
  void sb
    .from('service_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => undefined);
  return { ok: true, data: { userId: data.user_id, tokenId: data.id } };
}

// === requirePollHmac ===

export interface PollHmacData {
  rawBody: string;
}

export async function requirePollHmac(req: Request): Promise<AuthResult<PollHmacData>> {
  const secret = process.env.POLL_HMAC_SECRET;
  if (!secret) {
    return fail(respondError('internal_error', 'POLL_HMAC_SECRET not set', 500));
  }
  const provided = req.headers.get('x-signature');
  if (!provided) {
    return fail(respondError('invalid_token', 'missing X-Signature header', 401));
  }
  const rawBody = await req.text();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  // Constant-time compare; both sides must be equal-length hex.
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(provided.toLowerCase(), 'hex');
  } catch {
    return fail(respondError('invalid_token', 'malformed signature', 401));
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return fail(respondError('invalid_token', 'hmac mismatch', 401));
  }
  return { ok: true, data: { rawBody } };
}

// Small helper for cron operators to compute the static signature once.
export function computePollSignature(body = ''): string {
  const secret = process.env.POLL_HMAC_SECRET;
  if (!secret) throw new Error('POLL_HMAC_SECRET not set');
  return createHmac('sha256', secret).update(body).digest('hex');
}
