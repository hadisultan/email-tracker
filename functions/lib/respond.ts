// Standard JSON response envelope used by every Netlify function in this
// project (except the pixel endpoint, which always returns a GIF).
//
// Shape on error:  { error: { code, message, details? } }
// Shape on success: arbitrary JSON body.

export type ErrorCode =
  | 'idempotency_required'
  | 'invalid_jwt'
  | 'invalid_token'
  | 'not_authorized'
  | 'code_invalid'
  | 'code_expired'
  | 'code_consumed'
  | 'bad_request'
  | 'internal_error'
  | 'method_not_allowed'
  | 'forbidden'
  | 'not_found';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export function respondError(
  code: ErrorCode,
  message: string,
  status: number,
  details?: unknown,
): Response {
  const body: ErrorEnvelope = {
    error: details === undefined ? { code, message } : { code, message, details },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export function respondJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export function respondNoContent(): Response {
  return new Response(null, { status: 204 });
}
