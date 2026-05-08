// One row in the Messages page list. Collapsed by default; click the
// row header to expand and lazy-load this message's pixel hits via the
// loader prop (Messages page knows how to query supabase).

import { useEffect, useState } from 'react';
import { OpensTimeline, type PixelHit } from './OpensTimeline.js';
import { MultiRecipientNotice } from './MultiRecipientNotice.js';
import { GmailCachingNotice } from './GmailCachingNotice.js';
import { AppleMPPNotice } from './AppleMPPNotice.js';
import type { Filter } from '../types.js';

export interface MessageSummary {
  id: string;
  subject: string | null;
  recipients: string[];
  sent_at: string | null;
  created_at: string;
  hit_count: number;
}

interface Props {
  message: MessageSummary;
  filter: Filter;
  loadHits: (messageId: string, filter: Filter) => Promise<PixelHit[]>;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function MessageRow({ message, filter, loadHits }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [hits, setHits] = useState<PixelHit[] | null>(null);
  const [loadedFilter, setLoadedFilter] = useState<Filter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchHits(currentFilter: Filter): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const data = await loadHits(message.id, currentFilter);
      setHits(data);
      setLoadedFilter(currentFilter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // If the parent filter changes while the row is expanded, re-fetch
  // immediately so the visible timeline reflects the new filter. When
  // collapsed, we just clear the cached `hits` so the next expand
  // refetches under the right filter.
  useEffect(() => {
    if (loadedFilter !== null && loadedFilter !== filter) {
      if (expanded) {
        void fetchHits(filter);
      } else {
        setHits(null);
        setLoadedFilter(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function toggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (hits !== null && loadedFilter === filter) return;
    await fetchHits(filter);
  }

  const subject = message.subject ?? '(no subject)';
  const recipientLine =
    message.recipients.length === 0
      ? '(unknown recipient)'
      : message.recipients.length <= 2
        ? message.recipients.join(', ')
        : `${message.recipients[0]} +${message.recipients.length - 1} more`;
  const proxyLabels = (hits ?? []).map((h) => h.proxy_label).filter((p): p is string => !!p);

  return (
    <li
      style={{
        listStyle: 'none',
        padding: '12px',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#fff',
        marginBottom: 8,
      }}
      data-testid="message-row"
    >
      <button
        onClick={toggle}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          minHeight: 44,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <span style={{ fontWeight: 600, color: '#0f172a' }}>{subject}</span>
        <span style={{ fontSize: '0.85rem', color: '#475569' }}>{recipientLine}</span>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
          Sent {formatDate(message.sent_at ?? message.created_at)} •{' '}
          <strong>{message.hit_count}</strong> {message.hit_count === 1 ? 'open' : 'opens'}
        </span>
      </button>

      <MultiRecipientNotice recipientCount={message.recipients.length} />
      <GmailCachingNotice recipients={message.recipients} hitCount={message.hit_count} />
      <AppleMPPNotice recipients={message.recipients} proxyLabels={proxyLabels} />

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {loading && <p style={{ color: '#64748b' }}>Loading opens…</p>}
          {error && <p style={{ color: '#b91c1c' }}>Failed to load opens: {error}</p>}
          {!loading && !error && hits && <OpensTimeline hits={hits} />}
        </div>
      )}
    </li>
  );
}
