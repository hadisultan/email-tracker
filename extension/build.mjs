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
// Steps:
//   1. tsc --noEmit for type checking only.
//   2. esbuild bundles src/content/gmail.ts -> dist/content/gmail.js (IIFE).
//   3. esbuild bundles src/service-worker.ts -> dist/service-worker.js (ESM).
//   4. esbuild bundles src/popup/popup.ts -> dist/popup/popup.js (ESM).
//   5. Copy manifest.json, popup.html, popup.css, assets/icon-*.png.
//
// `npm run package` zips dist/ for distribution to a fresh machine —
// see scripts/package.mjs.

import { build as esbuild } from 'esbuild';
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, 'dist');
const SRC = resolve(HERE, 'src');
const ASSETS = resolve(HERE, 'assets');

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log('[build] type-checking with tsc...');
execSync('npx tsc -p tsconfig.json --noEmit', { cwd: HERE, stdio: 'inherit' });

const common = {
  bundle: true,
  sourcemap: true,
  target: 'chrome120',
  logLevel: 'warning',
  // Build-time injection of the production API base. Source default
  // is localhost:8888 so tests assert against that. Built bundles get
  // the real URL spliced in here.
  define: {
    'globalThis.__API_BASE__': JSON.stringify(
      process.env.EMAIL_TRACKER_API_BASE ?? 'https://hadi-email-tracker.netlify.app',
    ),
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

console.log('[build] copying manifest.json...');
copyFileSync(resolve(HERE, 'manifest.json'), resolve(DIST, 'manifest.json'));

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
