// Pure compose-send handler. Given the data the orchestrator collected
// from the compose dialog plus a `mintFn` callback, returns the new
// body HTML to write back. No DOM access, no globals, no fetch — those
// are the orchestrator's responsibility (gmail.ts).
//
// The 2 second timeout is enforced here via Promise.race + AbortError-
// like signal. Tests mock `mintFn` and can verify both fast-path and
// timeout-path behavior.

import { appendPixelToHtml } from './inject-pixel.js';

export interface MintFnInput {
  subject: string;
  recipients: string[];
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  sent_at: string;
}

export interface MintFnResult {
  token: string;
  pixel_url: string;
}

export type MintFn = (
  body: MintFnInput,
  idempotencyKey: string,
  signal: AbortSignal,
) => Promise<MintFnResult>;

export interface HandleComposeSendInput {
  recipients: string[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  messageId: string | null;
  mintFn: MintFn;
  now: () => Date;
  idempotencyKey: string;
  timeoutMs?: number;
}

export type MintErrorReason = 'timeout' | 'mint_failed';

export interface HandleComposeSendOutput {
  newBodyHtml: string;
  pixelUrl?: string;
  mintError?: MintErrorReason;
}

// 5s default timeout. Netlify Functions cold-starts can take 2-4s on
// the free tier; 5s leaves a margin while still being short enough that
// the user doesn't notice an obvious delay before Gmail's Send fires.
// Tests pass an explicit timeoutMs to keep their runs deterministic.
const DEFAULT_TIMEOUT_MS = 5000;

export async function handleComposeSend(
  input: HandleComposeSendInput,
): Promise<HandleComposeSendOutput> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const mintBody: MintFnInput = {
    subject: input.subject,
    recipients: input.recipients,
    gmail_thread_id: input.threadId,
    gmail_message_id: input.messageId,
    sent_at: input.now().toISOString(),
  };

  const result = await raceWithTimeout(
    input.mintFn(mintBody, input.idempotencyKey, ac.signal),
    timeoutMs,
    ac,
  );

  if (result.kind === 'timeout') {
    return { newBodyHtml: input.bodyHtml, mintError: 'timeout' };
  }
  if (result.kind === 'error') {
    return { newBodyHtml: input.bodyHtml, mintError: 'mint_failed' };
  }
  return {
    newBodyHtml: appendPixelToHtml(input.bodyHtml, result.value.pixel_url),
    pixelUrl: result.value.pixel_url,
  };
}

type RaceResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

async function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  ac: AbortController,
): Promise<RaceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RaceResult<T>>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ kind: 'timeout' });
    }, ms);
  });
  const wrapped: Promise<RaceResult<T>> = p.then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  try {
    return await Promise.race([wrapped, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
