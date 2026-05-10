// Build pipeline for the email-tracker Chrome extension.
//
// Why bundling: Chrome MV3 content scripts run as classic scripts and
// cannot use ES `import`/`export` syntax. Plain `tsc` emit preserves
// module syntax, so loading the unpacked extension fails with
// "Cannot use import statement outside a module" at the content-script
// entry. We use esbuild to bundle each entry into a single file, with
// the content script in IIFE format (no module syntax in the output).
// The service worker (manifest declares `type: "module"`) and the
// popup (`<script type="module">`) stay as ESM bundles.
//
// Environment:
//   EMAIL_TRACKER_API_BASE   Backend origin the built extension talks
//                            to (e.g. https://your-deploy.netlify.app).
//                            Defaults to http://localhost:8888 so a
//                            no-arg `npm run build` produces a dev-
//                            wired bundle. The value is injected two
//                            places: as `globalThis.__API_BASE__` (read
//                            at runtime by src/lib/config.ts) and as a
//                            host_permissions entry in the dist'd
//                            manifest.json (the source manifest carries
//                            a `__API_BASE_HOST__/*` placeholder so no
//                            real URL is committed to the repo —
//                            Netlify's secret scanner blocks builds
//                            otherwise).
//
// Steps:
//   1. tsc --noEmit for type checking only.
//   2. esbuild bundles src/content/gmail.ts -> dist/content/gmail.js (IIFE).
//   3. esbuild bundles src/service-worker.ts -> dist/service-worker.js (ESM).
//   4. esbuild bundles src/popup/popup.ts -> dist/popup/popup.js (ESM).
//   5. Read manifest.json, substitute __API_BASE_HOST__, write to dist/.
//   6. Copy popup.html, popup.css, assets/icon-*.png.
//
// `npm run package` zips dist/ for distribution to a fresh machine —
// see scripts/package.mjs.

import { build as esbuild } from 'esbuild';
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, 'dist');
const SRC = resolve(HERE, 'src');
const ASSETS = resolve(HERE, 'assets');

const API_BASE = process.env.EMAIL_TRACKER_API_BASE ?? 'http://localhost:8888';

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log(`[build] EMAIL_TRACKER_API_BASE = ${API_BASE}`);

console.log('[build] type-checking with tsc...');
execSync('npx tsc -p tsconfig.json --noEmit', { cwd: HERE, stdio: 'inherit' });

const common = {
  bundle: true,
  sourcemap: true,
  target: 'chrome120',
  logLevel: 'warning',
  define: {
    'globalThis.__API_BASE__': JSON.stringify(API_BASE),
  },
};

console.log('[build] bundling content script (IIFE)...');
await esbuild({
  ...common,
  entryPoints: [resolve(SRC, 'content/gmail.ts')],
  outfile: resolve(DIST, 'content/gmail.js'),
  format: 'iife',
});

console.log('[build] bundling service worker (ESM)...');
await esbuild({
  ...common,
  entryPoints: [resolve(SRC, 'service-worker.ts')],
  outfile: resolve(DIST, 'service-worker.js'),
  format: 'esm',
});

console.log('[build] bundling popup script (ESM)...');
await esbuild({
  ...common,
  entryPoints: [resolve(SRC, 'popup/popup.ts')],
  outfile: resolve(DIST, 'popup/popup.js'),
  format: 'esm',
});

function copyTree(srcDir, destDir, filter = () => true) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const sp = resolve(srcDir, entry);
    const dp = resolve(destDir, entry);
    const st = statSync(sp);
    if (st.isDirectory()) {
      copyTree(sp, dp, filter);
    } else if (filter(sp)) {
      copyFileSync(sp, dp);
    }
  }
}

console.log('[build] writing manifest.json with API base substituted...');
{
  // Read the source manifest as text and replace the
  // __API_BASE_HOST__ placeholder with the URL passed via env (or the
  // localhost dev default). Keeping the substitution as a text replace
  // (rather than parsing JSON, mutating, re-stringifying) preserves
  // formatting and trailing newline so dist/manifest.json byte-diffs
  // cleanly against the source.
  const manifestSrc = readFileSync(resolve(HERE, 'manifest.json'), 'utf8');
  const manifestOut = manifestSrc.replaceAll('__API_BASE_HOST__', API_BASE);
  writeFileSync(resolve(DIST, 'manifest.json'), manifestOut);
}

console.log('[build] copying popup html/css...');
const popupSrc = resolve(SRC, 'popup');
const popupDist = resolve(DIST, 'popup');
mkdirSync(popupDist, { recursive: true });
for (const f of ['popup.html', 'popup.css']) {
  copyFileSync(resolve(popupSrc, f), resolve(popupDist, f));
}

console.log('[build] copying assets/...');
copyTree(ASSETS, resolve(DIST, 'assets'));

console.log('[build] done →', DIST);
