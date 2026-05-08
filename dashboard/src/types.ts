// Shared UI domain types for the dashboard.
//
// Filter governs which pixel-hit tags the Messages page displays:
//   - 'real'   : excludes self_view_desktop + likely_prefetch + matches none/self_view_mobile
//   - 'all'    : no tag filter
//   - 'hidden' : only the suppressed tags (debugging view)
// Centralised here so Messages.tsx and MessageRow.tsx can never drift.

export type Filter = 'real' | 'all' | 'hidden';
