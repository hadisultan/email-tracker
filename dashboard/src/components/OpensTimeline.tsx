// One row per pixel hit, ordered by hit_at DESC. Lazy-loaded from
// Supabase by MessageRow when the user expands a message.

import { TagChip, type Tag } from './TagChip.js';

export interface PixelHit {
  id: string;
  hit_at: string;
  ip: string | null;
  user_agent: string | null;
  geo: { city?: string; country?: string } | null;
  proxy_label: string | null;
  tag: Tag;
}

function formatGeo(geo: PixelHit['geo']): string {
  if (!geo) return '—';
  const city = geo.city ?? '';
  const country = geo.country ?? '';
  if (city && country) return `${city}, ${country}`;
  if (country) return country;
  if (city) return city;
  return '—';
}

function proxyBadge(label: string | null): string | null {
  if (!label) return null;
  if (label === 'google_image_proxy') return 'via Google proxy';
  if (label === 'icloud_private_relay') return 'via iCloud Private Relay';
  if (label === 'apple_mail_mpp') return 'via Apple MPP';
  return label;
}

export function OpensTimeline({ hits }: { hits: PixelHit[] }) {
  if (hits.length === 0) {
    return (
      <p style={{ color: '#64748b', fontStyle: 'italic', margin: '8px 0' }}>
        No opens yet — try sending again or check the recipient&apos;s filter
        settings.
      </p>
    );
  }
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: '8px 0 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {hits.map((hit) => {
        const ts = new Date(hit.hit_at);
        const proxy = proxyBadge(hit.proxy_label);
        return (
          <li
            key={hit.id}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              padding: '6px 0',
              borderTop: '1px solid #f1f5f9',
              fontSize: '0.85rem',
            }}
          >
            <time dateTime={hit.hit_at} style={{ color: '#0f172a', fontWeight: 500 }}>
              {ts.toLocaleString()}
            </time>
            <span style={{ color: '#64748b' }}>{formatGeo(hit.geo)}</span>
            <TagChip tag={hit.tag} />
            {proxy && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: '#475569',
                  background: '#f8fafc',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                {proxy}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
