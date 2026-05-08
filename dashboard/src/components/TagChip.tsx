// Small color-coded chip for a pixel_hits.tag value.
//
// Mapping (per plan):
//   none                 → green   ("real open")
//   self_view_*          → gray    (suppressed)
//   likely_prefetch      → amber   (Gmail/iCloud caching)
//   apple_mpp_suspected  → blue    (Apple MPP)
//   anything else        → gray    (unknown / future tag)

import type { CSSProperties } from 'react';

export type Tag =
  | 'none'
  | 'self_view_desktop'
  | 'self_view_mobile'
  | 'likely_prefetch'
  | 'apple_mpp_suspected'
  | string;

interface Style {
  background: string;
  color: string;
  label: string;
}

function styleFor(tag: Tag): Style {
  switch (tag) {
    case 'none':
      return { background: '#dcfce7', color: '#166534', label: 'Real open' };
    case 'self_view_desktop':
      return { background: '#e5e7eb', color: '#374151', label: 'Self view (desktop)' };
    case 'self_view_mobile':
      return { background: '#e5e7eb', color: '#374151', label: 'Self view (mobile)' };
    case 'likely_prefetch':
      return { background: '#fef3c7', color: '#92400e', label: 'Likely prefetch' };
    case 'apple_mpp_suspected':
      return { background: '#dbeafe', color: '#1e40af', label: 'Apple MPP' };
    default:
      return { background: '#e5e7eb', color: '#374151', label: tag };
  }
}

export function TagChip({ tag }: { tag: Tag }) {
  const s = styleFor(tag);
  const css: CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '0.75rem',
    fontWeight: 600,
    background: s.background,
    color: s.color,
    lineHeight: 1.4,
  };
  return (
    <span style={css} aria-label={`tag: ${s.label}`}>
      {s.label}
    </span>
  );
}
