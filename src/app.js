import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, readBody, parseBody, send, serveStatic } from './http/router.js';
import { currentUser } from './http/auth.js';
import { api } from './http/api.js';
import { log } from './lib/audit.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Builds the HTTP server. Kept separate from server.js so tests can start it on a random port.
export function createApp() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const route = api.match(req.method, url.pathname);
      if (!route) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(publicDir, req, res, url.pathname)) return;
        if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !path.extname(url.pathname)) {
          if (serveStatic(publicDir, req, res, '/index.html')) return;
        }
        throw new HttpError(404, 'Not found');
      }
      let user = null;
      if (!route.opts.public) {
        user = currentUser(req);
        if (!user) throw new HttpError(401, 'Sign in required');
        if (route.opts.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admin role required');
        // CSRF: mutating API calls must come from our own page (SameSite=Strict cookie + Origin check).
        if (req.method !== 'GET') {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
        }
      }
      const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      const body = parseBody(rawBody, String(req.headers['content-type'] || ''));
      const result = await route.handler({ req, res, params: route.params, query: Object.fromEntries(url.searchParams), body, rawBody, user });
      if (result !== undefined && !res.headersSent) send(res, 200, result);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Internal server error' : e.message });
      else res.end();
    }
  });
}
