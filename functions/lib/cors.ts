// Per-origin CORS allow logic. Reads DASHBOARD_ORIGIN and EXTENSION_ORIGIN
// from env. Both are exact-match origins (no globs), e.g.
//
//   DASHBOARD_ORIGIN=https://email-tracker.example.com
//   EXTENSION_ORIGIN=chrome-extension://abcdefghijklmnop...
//
// Multiple origins per env var are supported via a comma-separated list so
// preview deploys (Netlify branch URLs) and a stable production URL can
// coexist without code changes.

import type { Context } from '@netlify/functions';
import { respondError } from './respond.js';

const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key';
const ALLOW_METHODS = 'GET, POST, OPTIONS';
const MAX_AGE_SECONDS = '86400';

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  for (const env of ['DASHBOARD_ORIGIN', 'EXTENSION_ORIGIN']) {
    const raw = process.env[env];
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

function pickAllowOrigin(req: Request): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  return allowedOrigins().has(origin) ? origin : null;
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const allow = pickAllowOrigin(req);
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
  };
}

function preflightResponse(req: Request): Response {
  const allow = pickAllowOrigin(req);
  if (!allow) {
    return respondError('forbidden', 'origin not allowed', 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': ALLOW_METHODS,
      'Access-Control-Allow-Headers': ALLOW_HEADERS,
      'Access-Control-Max-Age': MAX_AGE_SECONDS,
      'Vary': 'Origin',
    },
  });
}

export type FunctionHandler = (req: Request, ctx: Context) => Promise<Response> | Response;

export function withCors(handler: FunctionHandler): FunctionHandler {
  return async (req, ctx) => {
    if (req.method === 'OPTIONS') return preflightResponse(req);

    const inner = await handler(req, ctx);
    const cors = corsHeadersFor(req);
    if (Object.keys(cors).length === 0) return inner;

    const headers = new Headers(inner.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(inner.body, {
      status: inner.status,
      statusText: inner.statusText,
      headers,
    });
  };
}
