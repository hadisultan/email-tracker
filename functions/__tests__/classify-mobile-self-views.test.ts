import { describe, expect, it } from 'vitest';
import { extractUnreadRemovedThreadIds } from '../lib/classify-mobile-self-views.js';
import type { HistoryRecord } from '../lib/gmail-api.js';

function rec(
  id: string,
  labelsRemoved: HistoryRecord['labelsRemoved'],
): HistoryRecord {
  return { id, labelsRemoved };
}

describe('extractUnreadRemovedThreadIds', () => {
  it('returns [] for empty history', () => {
    expect(extractUnreadRemovedThreadIds([])).toEqual([]);
  });

  it('returns [] when no record has labelsRemoved', () => {
    const history: HistoryRecord[] = [
      { id: '1', messages: [{ id: 'm1', threadId: 'T1' }] },
      { id: '2' },
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual([]);
  });

  it('extracts a single thread when one labelRemoved record has UNREAD', () => {
    const history: HistoryRecord[] = [
      rec('100', [
        {
          message: { id: 'm1', threadId: 'T1' },
          labelIds: ['UNREAD'],
        },
      ]),
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual(['T1']);
  });

  it('extracts multiple distinct threads', () => {
    const history: HistoryRecord[] = [
      rec('100', [
        { message: { id: 'm1', threadId: 'T1' }, labelIds: ['UNREAD'] },
      ]),
      rec('101', [
        { message: { id: 'm2', threadId: 'T2' }, labelIds: ['UNREAD'] },
      ]),
    ];
    const out = extractUnreadRemovedThreadIds(history);
    expect(out.sort()).toEqual(['T1', 'T2']);
  });

  it('dedupes the same thread appearing across multiple records', () => {
    const history: HistoryRecord[] = [
      rec('100', [
        { message: { id: 'm1', threadId: 'T1' }, labelIds: ['UNREAD'] },
      ]),
      rec('101', [
        { message: { id: 'm2', threadId: 'T1' }, labelIds: ['UNREAD'] },
      ]),
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual(['T1']);
  });

  it('ignores labelRemoved entries that do NOT include UNREAD', () => {
    // User removed CATEGORY_PROMOTIONS — not a self-view signal.
    const history: HistoryRecord[] = [
      rec('100', [
        {
          message: { id: 'm1', threadId: 'T1' },
          labelIds: ['CATEGORY_PROMOTIONS'],
        },
      ]),
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual([]);
  });

  it('mixed records: only UNREAD-bearing ones contribute', () => {
    const history: HistoryRecord[] = [
      rec('100', [
        { message: { id: 'm1', threadId: 'T1' }, labelIds: ['UNREAD'] },
        {
          message: { id: 'm2', threadId: 'T2' },
          labelIds: ['CATEGORY_FORUMS'],
        },
      ]),
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual(['T1']);
  });

  it('accepts records where labelIds contains additional labels alongside UNREAD', () => {
    const history: HistoryRecord[] = [
      rec('100', [
        {
          message: { id: 'm1', threadId: 'T1' },
          labelIds: ['UNREAD', 'INBOX'],
        },
      ]),
    ];
    expect(extractUnreadRemovedThreadIds(history)).toEqual(['T1']);
  });

  it('defensively skips entries with non-array labelIds', () => {
    const history = [
      {
        id: '100',
        labelsRemoved: [
          { message: { id: 'm1', threadId: 'T1' }, labelIds: 'UNREAD' },
        ],
      },
    ] as unknown as HistoryRecord[];
    expect(extractUnreadRemovedThreadIds(history)).toEqual([]);
  });

  it('defensively skips entries with missing/blank threadId', () => {
    const history = [
      {
        id: '100',
        labelsRemoved: [
          { message: { id: 'm1' }, labelIds: ['UNREAD'] },
          { message: { id: 'm2', threadId: '' }, labelIds: ['UNREAD'] },
          { message: { id: 'm3', threadId: 'T_ok' }, labelIds: ['UNREAD'] },
        ],
      },
    ] as unknown as HistoryRecord[];
    expect(extractUnreadRemovedThreadIds(history)).toEqual(['T_ok']);
  });
});
