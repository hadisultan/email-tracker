import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoryNotFoundError,
  getProfile,
  historyList,
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
