// API base URL for the email-tracker backend.
//
// Default targets local Netlify dev (`netlify dev` on :8888) so the
// unpacked extension talks to the same machine that serves the dashboard.
//
// For a production build, pass the URL via the EMAIL_TRACKER_API_BASE
// env var to the extension build script:
//   EMAIL_TRACKER_API_BASE=https://your-deploy.netlify.app \
//     npm run build --workspace=extension
// build.mjs uses esbuild's `define` option to splice the URL in as
// `globalThis.__API_BASE__` and substitutes it into the dist'd
// manifest.json `host_permissions` entry. The committed source tree
// never references a specific deployment URL.

declare const globalThis: {
  __API_BASE__?: string;
} & typeof window;

export function apiBase(): string {
  return globalThis.__API_BASE__ ?? 'http://localhost:8888';
}
