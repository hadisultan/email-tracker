// Package script — zips extension/dist/ into extension-vX.Y.Z.zip for
// distribution to a fresh machine. Reads the version from
// extension/package.json so the zip name and the manifest stay in sync.
//
// Usage:  node scripts/package.mjs
// Or:     npm run package

import archiver from 'archiver';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..');
const DIST = resolve(EXT, 'dist');

if (!existsSync(DIST)) {
  console.error('[package] dist/ does not exist — run `npm run build` first');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve(EXT, 'package.json'), 'utf8'));
const out = resolve(EXT, `extension-v${pkg.version}.zip`);

const output = createWriteStream(out);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`[package] wrote ${out} (${output.bytesWritten} bytes)`);
});
archive.on('warning', (err) => {
  if (err.code !== 'ENOENT') throw err;
});
archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(DIST, false);
await archive.finalize();
