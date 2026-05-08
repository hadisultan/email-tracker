import { describe, expect, it, vi } from 'vitest';
import {
  handleComposeSend,
  type MintFn,
  type MintFnInput,
} from '../src/content/compose-handler.js';

const NOW_ISO = '2026-05-08T17:00:00.000Z';
const idem = '00000000-0000-4000-8000-000000000000';

function fakeNow(): Date {
  return new Date(NOW_ISO);
}

describe('handleComposeSend — happy paths', () => {
  it('mint success: returns body with pixel injected and no mintError', async () => {
    const mintFn: MintFn = vi.fn(async () => ({
      token: 'tk_abc',
      pixel_url: 'http://localhost:8888/pixel/tk_abc',
    }));

    const result = await handleComposeSend({
      recipients: ['friend@example.com'],
      subject: 'hi',
      bodyHtml: '<p>hello</p>',
      threadId: 'thr-1',
      messageId: null,
      mintFn,
      now: fakeNow,
      idempotencyKey: idem,
    });

    expect(result.mintError).toBeUndefined();
    expect(result.pixelUrl).toBe('http://localhost:8888/pixel/tk_abc');
    expect(result.newBodyHtml.startsWith('<p>hello</p>')).toBe(true);
    expect(result.newBodyHtml).toMatch(
      /<img src="http:\/\/localhost:8888\/pixel\/tk_abc" /,
    );
    expect(mintFn).toHaveBeenCalledTimes(1);
    const [body, key] = (mintFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]! as [MintFnInput, string];
    expect(key).toBe(idem);
    expect(body.subject).toBe('hi');
    expect(body.recipients).toEqual(['friend@example.com']);
    expect(body.gmail_thread_id).toBe('thr-1');
    expect(body.gmail_message_id).toBeNull();
    expect(body.sent_at).toBe(NOW_ISO);
  });

  it('multi-recipient: mint called once with the full recipients array', async () => {
    const mintFn: MintFn = vi.fn(async () => ({
      token: 't',
      pixel_url: 'http://x/pixel/t',
    }));
    await handleComposeSend({
      recipients: ['a@x', 'b@y', 'c@z'],
      subject: 's',
      bodyHtml: '',
      threadId: null,
      messageId: null,
      mintFn,
      now: fakeNow,
      idempotencyKey: idem,
    });
    expect(mintFn).toHaveBeenCalledTimes(1);
    const [body] = (mintFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]! as [MintFnInput, string];
    expect(body.recipients).toEqual(['a@x', 'b@y', 'c@z']);
  });

  it('missing thread ID: mint called with gmail_thread_id=null and pixel still injected', async () => {
    const mintFn: MintFn = vi.fn(async () => ({
      token: 't',
      pixel_url: 'http://x/pixel/t',
    }));
    const result = await handleComposeSend({
      recipients: ['a@x'],
      subject: 's',
      bodyHtml: '<p>hi</p>',
      threadId: null,
      messageId: null,
      mintFn,
      now: fakeNow,
      idempotencyKey: idem,
    });
    expect(result.mintError).toBeUndefined();
    expect(result.newBodyHtml).toContain('http://x/pixel/t');
    const [body] = (mintFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]! as [MintFnInput, string];
    expect(body.gmail_thread_id).toBeNull();
    expect(body.gmail_message_id).toBeNull();
  });
});

describe('handleComposeSend — error paths', () => {
  it('mint rejection: returns original body and mintError=mint_failed', async () => {
    const mintFn: MintFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await handleComposeSend({
      recipients: ['a@x'],
      subject: 's',
      bodyHtml: '<p>original</p>',
      threadId: null,
      messageId: null,
      mintFn,
      now: fakeNow,
      idempotencyKey: idem,
    });
    expect(result.mintError).toBe('mint_failed');
    expect(result.newBodyHtml).toBe('<p>original</p>');
    expect(result.pixelUrl).toBeUndefined();
  });

  it('mint timeout: returns original body and mintError=timeout', async () => {
    vi.useFakeTimers();
    try {
      const mintFn: MintFn = () =>
        new Promise(() => {
          /* never resolves */
        });
      const promise = handleComposeSend({
        recipients: ['a@x'],
        subject: 's',
        bodyHtml: '<p>original</p>',
        threadId: null,
        messageId: null,
        mintFn,
        now: fakeNow,
        idempotencyKey: idem,
        timeoutMs: 2000,
      });
      await vi.advanceTimersByTimeAsync(2001);
      const result = await promise;
      expect(result.mintError).toBe('timeout');
      expect(result.newBodyHtml).toBe('<p>original</p>');
    } finally {
      vi.useRealTimers();
    }
  });

  it('mint timeout: aborts the AbortSignal passed to mintFn', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const mintFn: MintFn = (_body, _key, signal) => {
        receivedSignal = signal;
        return new Promise(() => {});
      };
      const promise = handleComposeSend({
        recipients: ['a@x'],
        subject: 's',
        bodyHtml: '',
        threadId: null,
        messageId: null,
        mintFn,
        now: fakeNow,
        idempotencyKey: idem,
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(101);
      await promise;
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call mintFn more than once for a single send', async () => {
    const mintFn: MintFn = vi.fn(async () => ({
      token: 't',
      pixel_url: 'http://x/pixel/t',
    }));
    await handleComposeSend({
      recipients: ['a@x'],
      subject: 's',
      bodyHtml: '',
      threadId: null,
      messageId: null,
      mintFn,
      now: fakeNow,
      idempotencyKey: idem,
    });
    expect(mintFn).toHaveBeenCalledTimes(1);
  });
});
