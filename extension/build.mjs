// Build pipeline for the email-tracker Chrome extension.
//
// Steps:
//   1. tsc compiles src/ -> dist/ (mirrors directory structure;
//      service-worker, popup/popup.js, content/gmail.js, lib/api.js,
//      lib/config.js).
//   2. Copy manifest.json -> dist/manifest.json.
//   3. Copy popup.html and popup.css -> dist/popup/.
//   4. Copy assets/icon-*.png -> dist/assets/.
//
// `npm run package` bundles dist/ into extension-vX.Y.Z.zip for
// distribution to a fresh machine — see scripts/package.mjs.

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

console.log('[build] compiling TypeScript...');
execSync('npx tsc -p tsconfig.json', { cwd: HERE, stdio: 'inherit' });

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
