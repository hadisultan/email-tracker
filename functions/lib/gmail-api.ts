// Thin wrapper over Gmail's REST API for the poller (Unit 7).
//
// Two endpoints are used:
//   - GET /gmail/v1/users/me/profile           → current historyId baseline
//   - GET /gmail/v1/users/me/history           → cursor-paginated change log
//
// We deliberately do not pull in `googleapis` — the surface we need is
// tiny (two endpoints, one auth header, no streaming), and avoiding the
// dep keeps the cold-start path lean for Netlify Functions.
//
// Error mapping:
//   - 404 from history.list → `HistoryNotFoundError`. This means the
//     stored cursor is older than Gmail's retention window (typically
//     ~7 days) and the caller must re-baseline via `getProfile` and
//     skip processing this run.
//   - Anything else non-2xx → generic `Error` with the status surfaced.

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class HistoryNotFoundError extends Error {
  override readonly name = 'HistoryNotFoundError';
}

export interface ProfileResult {
  historyId: string;
  emailAddress: string;
}

export async function getProfile(accessToken: string): Promise<ProfileResult> {
  const res = await fetch(`${GMAIL_API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`gmail profile failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { historyId?: unknown; emailAddress?: unknown };
  if (typeof json.historyId !== 'string' || typeof json.emailAddress !== 'string') {
    throw new Error('gmail profile response missing fields');
  }
  return { historyId: json.historyId, emailAddress: json.emailAddress };
}

// Single Gmail history record (one row from history.list response).
export interface HistoryLabelsRemoved {
  message: { id: string; threadId: string; labelIds?: string[] };
  labelIds: string[];
}

export interface HistoryRecord {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  labelsRemoved?: HistoryLabelsRemoved[];
  // Other history-type fields (messagesAdded, labelsAdded) intentionally
  // omitted — the poller only filters on labelsRemoved.
}

export interface HistoryListResult {
  history: HistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

export interface HistoryListOptions {
  accessToken: string;
  startHistoryId: string;
  historyTypes?: ReadonlyArray<string>;
  labelId?: string;
  pageToken?: string;
}

export async function historyList(opts: HistoryListOptions): Promise<HistoryListResult> {
  const params = new URLSearchParams();
  params.set('startHistoryId', opts.startHistoryId);
  for (const t of opts.historyTypes ?? []) params.append('historyTypes', t);
  if (opts.labelId) params.set('labelId', opts.labelId);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);

  const res = await fetch(`${GMAIL_API_BASE}/history?${params.toString()}`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (res.status === 404) {
    throw new HistoryNotFoundError('history cursor too old');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`gmail history failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    history?: unknown;
    historyId?: unknown;
    nextPageToken?: unknown;
  };
  if (typeof json.historyId !== 'string') {
    throw new Error('gmail history response missing historyId');
  }
  const history = Array.isArray(json.history) ? (json.history as HistoryRecord[]) : [];
  const result: HistoryListResult = {
    history,
    historyId: json.historyId,
  };
  if (typeof json.nextPageToken === 'string' && json.nextPageToken.length > 0) {
    result.nextPageToken = json.nextPageToken;
  }
  return result;
}
