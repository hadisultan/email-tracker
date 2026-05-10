import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoryNotFoundError,
  getMessageMetadata,
  getProfile,
  historyList,
  listSentMessages,
} from '../lib/gmail-api.js';

const ACCESS_TOKEN = 'ya29.test_access';

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch') as never;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getProfile', () => {
  it('GETs /profile with bearer and returns historyId + emailAddress', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        emailAddress: 'me@example.com',
        historyId: '12345',
        messagesTotal: 100,
      }) as never,
    );
    const result = await getProfile(ACCESS_TOKEN);

    expect(result).toEqual({ historyId: '12345', emailAddress: 'me@example.com' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect((init as RequestInit).headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  });

  it('throws on non-2xx', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'unauth' }) as never);
    await expect(getProfile(ACCESS_TOKEN)).rejects.toThrow(/gmail profile failed: 401/);
  });

  it('throws when response is missing required fields', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { messagesTotal: 5 }) as never);
    await expect(getProfile(ACCESS_TOKEN)).rejects.toThrow(/missing fields/);
  });
});

describe('historyList', () => {
  it('encodes startHistoryId, historyTypes (repeated), labelId, pageToken in the query string', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { history: [], historyId: '999' }) as never,
    );

    await historyList({
      accessToken: ACCESS_TOKEN,
      startHistoryId: '500',
      historyTypes: ['labelRemoved', 'messageAdded'],
      labelId: 'UNREAD',
      pageToken: 'PT_ABC',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/history',
    );
    expect(u.searchParams.get('startHistoryId')).toBe('500');
    expect(u.searchParams.getAll('historyTypes')).toEqual([
      'labelRemoved',
      'messageAdded',
    ]);
    expect(u.searchParams.get('labelId')).toBe('UNREAD');
    expect(u.searchParams.get('pageToken')).toBe('PT_ABC');
  });

  it('returns parsed history + historyId + nextPageToken', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        history: [
          {
            id: '700',
            labelsRemoved: [
              { message: { id: 'm1', threadId: 'T1' }, labelIds: ['UNREAD'] },
            ],
          },
        ],
        historyId: '750',
        nextPageToken: 'PT_NEXT',
      }) as never,
    );

    const result = await historyList({
      accessToken: ACCESS_TOKEN,
      startHistoryId: '500',
      historyTypes: ['labelRemoved'],
      labelId: 'UNREAD',
    });

    expect(result.historyId).toBe('750');
    expect(result.nextPageToken).toBe('PT_NEXT');
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.labelsRemoved![0]!.message.threadId).toBe('T1');
  });

  it('returns empty history array when the API omits the history field', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { historyId: '600' }) as never);
    const result = await historyList({
      accessToken: ACCESS_TOKEN,
      startHistoryId: '500',
    });
    expect(result.history).toEqual([]);
    expect(result.historyId).toBe('600');
    expect(result.nextPageToken).toBeUndefined();
  });

  it('throws HistoryNotFoundError on 404', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(404, { error: { code: 404, message: 'history too old' } }) as never,
    );
    await expect(
      historyList({ accessToken: ACCESS_TOKEN, startHistoryId: '500' }),
    ).rejects.toBeInstanceOf(HistoryNotFoundError);
  });

  it('throws generic Error on other non-2xx statuses', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(503, { error: 'down' }) as never);
    await expect(
      historyList({ accessToken: ACCESS_TOKEN, startHistoryId: '500' }),
    ).rejects.toThrow(/gmail history failed: 503/);
  });

  it('throws when response is missing historyId', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { history: [] }) as never);
    await expect(
      historyList({ accessToken: ACCESS_TOKEN, startHistoryId: '500' }),
    ).rejects.toThrow(/missing historyId/);
  });
});

describe('listSentMessages', () => {
  it('GETs /messages with q=in:sent newer_than:1d, maxResults=50, fields=messages(id,threadId) by default', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        messages: [
          { id: 'gm-1', threadId: 'th-1' },
          { id: 'gm-2', threadId: 'th-2' },
        ],
      }) as never,
    );
    const result = await listSentMessages({ accessToken: ACCESS_TOKEN });
    expect(result).toEqual([
      { id: 'gm-1', threadId: 'th-1' },
      { id: 'gm-2', threadId: 'th-2' },
    ]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    );
    expect(u.searchParams.get('q')).toBe('in:sent newer_than:1d');
    expect(u.searchParams.get('maxResults')).toBe('50');
    expect(u.searchParams.get('fields')).toBe('messages(id,threadId)');
    expect((init as RequestInit).headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
  });

  it('honors newerThan and maxResults overrides', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { messages: [] }) as never);
    await listSentMessages({
      accessToken: ACCESS_TOKEN,
      newerThan: '2h',
      maxResults: 10,
    });
    const [url] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.searchParams.get('q')).toBe('in:sent newer_than:2h');
    expect(u.searchParams.get('maxResults')).toBe('10');
  });

  it('returns [] when messages field is missing or empty', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {}) as never);
    expect(await listSentMessages({ accessToken: ACCESS_TOKEN })).toEqual([]);

    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { messages: [] }) as never);
    expect(await listSentMessages({ accessToken: ACCESS_TOKEN })).toEqual([]);
  });

  it('skips entries with non-string id or threadId', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        messages: [
          { id: 'gm-good', threadId: 'th-good' },
          { id: 42, threadId: 'th-bad' },
          { id: 'gm-bad', threadId: null },
          { id: 'gm-good-2', threadId: 'th-good-2' },
        ],
      }) as never,
    );
    const result = await listSentMessages({ accessToken: ACCESS_TOKEN });
    expect(result).toEqual([
      { id: 'gm-good', threadId: 'th-good' },
      { id: 'gm-good-2', threadId: 'th-good-2' },
    ]);
  });

  it('throws on non-2xx', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: 'unauth' }) as never);
    await expect(
      listSentMessages({ accessToken: ACCESS_TOKEN }),
    ).rejects.toThrow(/gmail messages.list failed: 401/);
  });
});

describe('getMessageMetadata', () => {
  it('GETs /messages/{id}?format=metadata&metadataHeaders=Subject by default', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        id: 'gm-1',
        threadId: 'th-1',
        internalDate: '1715300000000',
        payload: { headers: [{ name: 'Subject', value: 'tracker test 16' }] },
      }) as never,
    );
    const result = await getMessageMetadata({
      accessToken: ACCESS_TOKEN,
      messageId: 'gm-1',
    });
    expect(result).toEqual({
      id: 'gm-1',
      threadId: 'th-1',
      internalDate: '1715300000000',
      headers: { subject: 'tracker test 16' },
    });
    const [url] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/gm-1',
    );
    expect(u.searchParams.get('format')).toBe('metadata');
    expect(u.searchParams.getAll('metadataHeaders')).toEqual(['Subject']);
  });

  it('encodes the messageId path segment', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        id: 'gm/with slash',
        threadId: 'th',
        internalDate: '0',
      }) as never,
    );
    await getMessageMetadata({
      accessToken: ACCESS_TOKEN,
      messageId: 'gm/with slash',
    });
    const [url] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.pathname).toBe(
      '/gmail/v1/users/me/messages/gm%2Fwith%20slash',
    );
  });

  it('passes through multiple headerNames as repeated query params', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        id: 'gm-1',
        threadId: 'th-1',
        internalDate: '0',
        payload: { headers: [] },
      }) as never,
    );
    await getMessageMetadata({
      accessToken: ACCESS_TOKEN,
      messageId: 'gm-1',
      headerNames: ['Subject', 'To', 'From'],
    });
    const [url] = fetchSpy.mock.calls[0]!;
    const u = new URL(url as string);
    expect(u.searchParams.getAll('metadataHeaders')).toEqual([
      'Subject',
      'To',
      'From',
    ]);
  });

  it('lower-cases header names in the result map', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        id: 'gm-1',
        threadId: 'th-1',
        internalDate: '1715300000000',
        payload: {
          headers: [
            { name: 'Subject', value: 'Hello' },
            { name: 'To', value: 'a@b.com' },
          ],
        },
      }) as never,
    );
    const result = await getMessageMetadata({
      accessToken: ACCESS_TOKEN,
      messageId: 'gm-1',
      headerNames: ['Subject', 'To'],
    });
    expect(result?.headers).toEqual({ subject: 'Hello', to: 'a@b.com' });
  });

  it('returns null on 404 (message evicted)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'gone' }) as never);
    const result = await getMessageMetadata({
      accessToken: ACCESS_TOKEN,
      messageId: 'gm-1',
    });
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { id: 'gm-1', threadId: 'th-1' }) as never,
    );
    expect(
      await getMessageMetadata({ accessToken: ACCESS_TOKEN, messageId: 'gm-1' }),
    ).toBeNull();
  });

  it('throws on non-404 error', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }) as never);
    await expect(
      getMessageMetadata({ accessToken: ACCESS_TOKEN, messageId: 'gm-1' }),
    ).rejects.toThrow(/gmail messages.get failed: 500/);
  });
});
