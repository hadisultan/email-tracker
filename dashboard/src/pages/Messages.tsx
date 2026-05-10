// Messages page — list of recent tracked sends with a filter pill row,
// HealthBanner, and per-message expandable open timelines.
//
// Reads happen via the user-scoped Supabase client (RLS enforces user
// ownership server-side). Pixel hits are lazy-loaded per row.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSupabase } from '../lib/supabase.js';
import { HealthBanner, type SystemHealth } from '../components/HealthBanner.js';
import { MessageRow, type MessageSummary } from '../components/MessageRow.js';
import type { PixelHit } from '../components/OpensTimeline.js';
import {
  getCurrentSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/web-push-client.js';
import type { Filter } from '../types.js';

const FILTER_TAGS: Record<Filter, string[] | null> = {
  real: ['none', 'self_view_mobile'],
  all: null,
  hidden: ['self_view_desktop', 'likely_prefetch'],
};

function countHitsForFilter(
  hits: { tag: string }[] | undefined,
  filterMode: Filter,
): number {
  if (!hits) return 0;
  const tags = FILTER_TAGS[filterMode];
  if (tags === null) return hits.length;
  const allowed = new Set(tags);
  return hits.filter((h) => allowed.has(h.tag)).length;
}

interface MessageWithCount extends MessageSummary {
  gmail_message_id: string | null;
  hit_tags: string[];
}

export function Messages() {
  const sb = getSupabase();
  const [filter, setFilter] = useState<Filter>('real');
  const [messages, setMessages] = useState<MessageWithCount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [hasPushSub, setHasPushSub] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: msgRows, error: msgErr } = await sb
          .from('messages')
          .select(
            'id, subject, recipients, sent_at, created_at, gmail_message_id, pixel_hits(tag)',
          )
          .order('sent_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(50);
        if (msgErr) throw new Error(msgErr.message);
        if (cancelled) return;
        const summaries: MessageWithCount[] = (msgRows ?? []).map((row) => {
          const r = row as {
            id: string;
            subject: string | null;
            recipients: string[] | null;
            sent_at: string | null;
            created_at: string;
            gmail_message_id: string | null;
            pixel_hits?: { tag: string }[];
          };
          const tags = (r.pixel_hits ?? []).map((h) => h.tag);
          return {
            id: r.id,
            subject: r.subject,
            recipients: r.recipients ?? [],
            sent_at: r.sent_at,
            created_at: r.created_at,
            gmail_message_id: r.gmail_message_id,
            hit_count: 0,
            hit_tags: tags,
          };
        });
        setMessages(summaries);

        const { data: healthRow, error: healthErr } = await sb
          .from('system_health')
          .select('*')
          .maybeSingle();
        if (!healthErr && !cancelled) setHealth(healthRow as SystemHealth | null);

        const sub = await getCurrentSubscription();
        if (!cancelled) setHasPushSub(sub !== null);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb]);

  const visibleMessages = useMemo(() => {
    if (!messages) return null;
    // hit_count is computed against the active filter so the badge
    // ("3 opens") matches what the timeline shows when the user
    // expands the row. Without this, "Real opens" filter shows zero
    // hits in the timeline while the badge still claims 3 opens
    // (which were all delivery-time prefetches).
    const counted = messages.map((m) => ({
      ...m,
      hit_count: countHitsForFilter(
        m.hit_tags.map((tag) => ({ tag })),
        filter,
      ),
    }));
    // Default 'real' filter hides "orphan" rows: messages with no
    // gmail_message_id (the mint API call succeeded but the Gmail send
    // never completed or never came back through History) AND older
    // than 30d AND no hits ever. Plan line 1784.
    if (filter !== 'real') return counted;
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    return counted.filter((m) => {
      if (m.hit_count > 0) return true;
      if (m.gmail_message_id !== null) return true;
      const created = new Date(m.created_at).getTime();
      return created >= cutoff;
    });
  }, [messages, filter]);

  async function loadHits(messageId: string, filterMode: Filter): Promise<PixelHit[]> {
    let query = sb
      .from('pixel_hits')
      .select('id, hit_at, ip, user_agent, geo, proxy_label, tag')
      .eq('message_id', messageId)
      .order('hit_at', { ascending: false });
    const tags = FILTER_TAGS[filterMode];
    if (tags) query = query.in('tag', tags);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []) as PixelHit[];
  }

  async function handleReauthorize() {
    window.location.assign('/');
  }
  async function handleResubscribe() {
    try {
      await unsubscribeFromPush();
      await subscribeToPush();
      setHasPushSub(true);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '16px' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <h1 style={{ margin: 0 }}>Tracked emails</h1>
        <Link
          to="/setup"
          style={{
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '10px 16px',
            background: '#fff',
            color: '#0f172a',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Setup
        </Link>
      </header>

      <HealthBanner
        health={health}
        hasPushSubscription={hasPushSub}
        onReauthorize={handleReauthorize}
        onResubscribe={handleResubscribe}
      />

      <div role="tablist" aria-label="Filter opens" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['real', 'all', 'hidden'] as Filter[]).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            style={{
              minHeight: 44,
              padding: '8px 14px',
              background: filter === f ? '#0f172a' : '#fff',
              color: filter === f ? '#fff' : '#0f172a',
              border: '1px solid #cbd5e1',
              borderRadius: 999,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {f === 'real' ? 'Real opens' : f === 'all' ? 'All' : 'Hidden'}
          </button>
        ))}
      </div>

      {loadError && (
        <p style={{ color: '#b91c1c' }}>Failed to load messages: {loadError}</p>
      )}
      {!loadError && messages === null && <p>Loading messages…</p>}
      {!loadError && visibleMessages !== null && visibleMessages.length === 0 && (
        <p style={{ color: '#475569' }}>
          No tracked emails yet — install the extension and pair it from{' '}
          <Link to="/setup">Setup</Link>.
        </p>
      )}
      {visibleMessages && visibleMessages.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {visibleMessages.map((m) => (
            <MessageRow key={m.id} message={m} filter={filter} loadHits={loadHits} />
          ))}
        </ul>
      )}
    </main>
  );
}
