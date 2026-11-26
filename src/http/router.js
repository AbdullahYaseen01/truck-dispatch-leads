import fs from 'node:fs';
import path from 'node:path';

// Minimal router on node:http (no framework dependency).

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, re, keys, handler, opts });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseBody(raw, contentType = '') {
  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

export function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

export function serveStatic(root, req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'referrer-policy': 'same-origin',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
