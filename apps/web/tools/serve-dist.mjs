#!/usr/bin/env node
/**
 * SEO-08: minimal static file server for Lighthouse CI.
 *
 * Serves a production dist dir (apps/web/dist/web/browser) with gzip for
 * text assets — mirroring SWA edge compression closely enough that the
 * transfer-size budgets (200 KB JS, 500 KB images) are meaningful.
 * Prerendered routes resolve to <route>/index.html; anything else falls back
 * to /index.html (SPA routes).
 *
 * Prints "serving <dir> on <port>" on ready (LHCI startServerReadyPattern).
 * No dependencies — node builtins only.
 *
 * Usage: node apps/web/tools/serve-dist.mjs --port 8931 --dist <dir>
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const GZIP_TYPES = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.xml']);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dist = arg('--dist', join(new URL('.', import.meta.url).pathname, '..', 'dist', 'web', 'browser'));
const port = Number(arg('--port', '8931'));

function resolveFile(urlPath) {
  const clean = normalize(urlPath.split(/[?#]/)[0]).replace(/^(\.\.[/\\])+/, '');
  const rel = clean.replace(/^\/+/, '');
  const candidates = [join(dist, rel)];
  if (!extname(rel)) candidates.push(join(dist, rel, 'index.html'));
  for (const c of candidates) {
    if (c.startsWith(dist) && existsSync(c) && statSync(c).isFile()) return c;
  }
  return join(dist, 'index.html'); // SPA fallback
}

createServer((req, res) => {
  try {
    const file = resolveFile(new URL(req.url, 'http://x').pathname);
    const ext = extname(file).toLowerCase();
    const body = readFileSync(file);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (acceptGzip && GZIP_TYPES.has(ext)) {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(body));
    } else {
      res.end(body);
    }
  } catch {
    res.statusCode = 500;
    res.end('error');
  }
}).listen(port, () => {
  console.log(`serving ${dist} on ${port}`);
});
