// API base URL for the email-tracker backend.
//
// Default targets local Netlify dev (`netlify dev` on :8888) so the
// unpacked extension talks to the same machine that serves the dashboard.
//
// For a production build, edit this constant before running `npm run
// build` (or override via globalThis.__API_BASE__ at build time — see
// build.mjs). When we add a config UI in a later unit, this becomes a
// stored preference instead of a build-time constant.

declare const globalThis: {
  __API_BASE__?: string;
} & typeof window;

export function apiBase(): string {
  return globalThis.__API_BASE__ ?? 'http://localhost:8888';
}
