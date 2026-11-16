// Packs the built site into the release download.
//   npm run build && node tools/release.mjs
// Writes release/FileConvert-v<version>.zip (every file in dist/, in sorted order, with a fixed date so the
// same build always gives the same bytes) and release/SHA256SUMS.txt (the ZIP and every file in it).
// --verify builds twice from scratch and fails unless both builds are byte-identical.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = process.cwd();
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sha = b => createHash('sha256').update(b).digest('hex');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}
const digestOf = () => listFiles(dist).map(f => `${sha(readFileSync(f))}  ${relative(dist, f).split(sep).join('/')}`).join('\n');

if (process.argv.includes('--verify')) {
  const build = () => execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], { stdio: 'inherit' });
  build();
  const first = digestOf();
  build();
  if (digestOf() !== first) { console.error('Two builds of the same sources differ.'); process.exit(1); }
  console.log(`Two builds are identical (${first.split('\n').length} files).`);
}

const files = listFiles(dist);
const entries = {};
const folder = `FileConvert-v${version}`;
const mtime = new Date('2026-01-01T00:00:00Z');
for (const f of files) entries[`${folder}/${relative(dist, f).split(sep).join('/')}`] = [new Uint8Array(readFileSync(f)), { mtime, level: 9 }];
const zip = zipSync(entries, { mtime });
mkdirSync(join(root, 'release'), { recursive: true });
const zipName = `${folder}.zip`;
writeFileSync(join(root, 'release', zipName), zip);
const sums = [`${sha(zip)}  ${zipName}`, ...digestOf().split('\n').map(l => l.replace('  ', `  ${folder}/`))].join('\n') + '\n';
writeFileSync(join(root, 'release', 'SHA256SUMS.txt'), sums);
console.log(`release/${zipName}: ${(zip.length / 1048576).toFixed(1)} MB, ${files.length} files, SHA-256 ${sha(zip)}`);
