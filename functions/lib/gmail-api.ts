// Thin wrapper over Gmail's REST API for the poller (Unit 7).
//
// Endpoints:
//   - GET /gmail/v1/users/me/profile           → current historyId baseline
//   - GET /gmail/v1/users/me/history           → cursor-paginated change log
//   - GET /gmail/v1/users/me/messages          → search recent sent messages
//                                                (used to backfill
//                                                `messages.gmail_thread_id`
//                                                for fresh sends — at
//                                                compose time the URL has
//                                                no thread yet, so the
//                                                extension stores NULL)
//   - GET /gmail/v1/users/me/messages/{id}     → message metadata + headers
//                                                (Subject, internalDate)
//                                                used to match Gmail
//                                                sends back to our rows.
//
// We deliberately do not pull in `googleapis` — the surface we need is
// tiny, all under a single auth header, and avoiding the dep keeps the
// cold-start path lean for Netlify Functions.
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

// `users.messages.list` minimal stub. We always read with
// `fields=messages(id,threadId)` so the response shape is fixed.
export interface SentMessageRef {
  id: string;
  threadId: string;
}

export interface ListSentMessagesOptions {
  accessToken: string;
  // Gmail search syntax fragment for "newer than" — e.g. '1d', '2h'.
  // Defaults to '1d'. We bound the search so a runaway poller doesn't
  // page through the entire mailbox.
  newerThan?: string;
  // Cap on result count. Personal accounts send <50/day so 50 is more
  // than enough for any reasonable backfill window.
  maxResults?: number;
}

// Searches `in:sent` for recent messages. Used by the thread-id
// backfill phase: at compose time the extension can't read the
// thread_id (URL has no thread fragment yet), so the message row is
// stored with `gmail_thread_id = NULL`. The poller asks Gmail for
// recent sends and matches them back to our rows by Subject +
// internalDate proximity. Required scope: `gmail.metadata` or
// `gmail.readonly`.
export async function listSentMessages(
  opts: ListSentMessagesOptions,
): Promise<SentMessageRef[]> {
  const params = new URLSearchParams();
  params.set('q', `in:sent newer_than:${opts.newerThan ?? '1d'}`);
  params.set('maxResults', String(opts.maxResults ?? 50));
  params.set('fields', 'messages(id,threadId)');

  const res = await fetch(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`gmail messages.list failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { messages?: unknown };
  if (!Array.isArray(json.messages)) return [];
  const out: SentMessageRef[] = [];
  for (const m of json.messages as Array<{ id?: unknown; threadId?: unknown }>) {
    if (typeof m.id === 'string' && typeof m.threadId === 'string') {
      out.push({ id: m.id, threadId: m.threadId });
    }
  }
  return out;
}

// `users.messages.get?format=metadata` minimal stub. `headers` is a
// flat lower-cased name → value map (Gmail returns headers as an array
// of {name, value}; the case-insensitive normalization is done here so
// callers can use a single canonical key like 'subject').
export interface MessageMetadata {
  id: string;
  threadId: string;
  // Gmail's internalDate is a unix epoch in milliseconds, returned as a
  // string. We keep it as a string here and let callers parse — that
  // way malformed values surface as NaN at the call site rather than
  // mid-fetch.
  internalDate: string;
  headers: Record<string, string>;
}

export interface GetMessageMetadataOptions {
  accessToken: string;
  messageId: string;
  // Specific headers to request. Gmail's API supports filtering at the
  // wire level — passing only the headers we read keeps the response
  // small. Defaults to ['Subject'].
  headerNames?: ReadonlyArray<string>;
}

export async function getMessageMetadata(
  opts: GetMessageMetadataOptions,
): Promise<MessageMetadata | null> {
  const params = new URLSearchParams();
  params.set('format', 'metadata');
  for (const h of opts.headerNames ?? ['Subject']) {
    params.append('metadataHeaders', h);
  }

  const res = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(opts.messageId)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${opts.accessToken}` } },
  );
  // 404 here means "Gmail no longer has this message" — caller should
  // skip this row, not abort the whole backfill cycle.
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`gmail messages.get failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    id?: unknown;
    threadId?: unknown;
    internalDate?: unknown;
    payload?: { headers?: Array<{ name?: unknown; value?: unknown }> };
  };
  if (
    typeof json.id !== 'string' ||
    typeof json.threadId !== 'string' ||
    typeof json.internalDate !== 'string'
  ) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const h of json.payload?.headers ?? []) {
    if (typeof h.name === 'string' && typeof h.value === 'string') {
      headers[h.name.toLowerCase()] = h.value;
    }
  }
  return {
    id: json.id,
    threadId: json.threadId,
    internalDate: json.internalDate,
    headers,
  };
}
