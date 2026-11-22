// Serves the built app from dist/ at /fileconvert/, the way radmagelabs.com is meant to: with the
// Content-Security-Policy as a header (plus frame-ancestors) and the other security headers.
//   node tools/serve.mjs [--port 4175] [--pages]
// --pages leaves the headers off, like GitHub Pages, so only the policy in the page's meta tag applies.
// Like both hosts, a folder address without its trailing slash is redirected to the address with it (GitHub
// Pages does this itself; radmagelabs.com does it with a redirect rule before its rewrite), and an address
// that does not exist gets 404.html with status 404.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { CSP, FRAME_ANCESTORS } from './csp.mjs';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 4175;
const pages = args.includes('--pages');
const root = resolve(process.env.FILECONVERT_DIST || 'dist');
const BASE = '/fileconvert/';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.bcmap': 'application/octet-stream',
  '.xml': 'application/xml; charset=utf-8',
};

export const HEADERS = {
  'Content-Security-Policy': `${CSP}; ${FRAME_ANCESTORS}`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/fileconvert') {
    res.writeHead(301, { Location: BASE });
    return res.end();
  }
  if (!url.pathname.startsWith(BASE)) { res.writeHead(404); return res.end('not found'); }
  let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
  const asFolder = normalize(join(root, rel));
  if (!rel.endsWith('/') && asFolder.startsWith(root) && existsSync(join(asFolder, 'index.html'))) {
    res.writeHead(301, { Location: `${url.pathname}/${url.search}` });
    return res.end();
  }
  if (rel.endsWith('/')) rel += 'index.html';
  let file = normalize(join(root, rel));
  let status = 200;
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(root, '404.html');
    status = 404;
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  }
  const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store' };
  if (!pages) Object.assign(headers, HEADERS);
  res.writeHead(status, headers);
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => console.log(`FileConvert at http://127.0.0.1:${port}${BASE}${pages ? ' (no headers, like GitHub Pages)' : ''}`));
