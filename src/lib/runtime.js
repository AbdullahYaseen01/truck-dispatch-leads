import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';

// Plain SMTP dialogue on port 25 used by the free mailbox probe. Returns every server reply.
// Stops early (after QUIT) when the greeting, EHLO or MAIL FROM is refused.
export function smtpConversation(host, steps, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(25, host);
    const replies = [];
    let buf = '';
    let i = 0;
    let finished = false;
    const done = (r) => { if (finished) return; finished = true; clearTimeout(t); sock.destroy(); resolve(r); };
    const t = setTimeout(() => done({ ok: false, error: 'timeout', replies }), timeoutMs);
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message, replies }));
    sock.on('close', () => done({ ok: replies.length > 0, error: 'connection closed', replies }));
    sock.on('data', (d) => {
      buf += d.toString();
      // A reply is complete when it ends with a line "NNN text" (multi-line replies use "NNN-").
      const lines = buf.split(/\r?\n/).filter(Boolean);
      if (!/\r?\n$/.test(buf) || !/^\d{3}( |$)/.test(lines[lines.length - 1] || '')) return;
      const code = Number(lines[lines.length - 1].slice(0, 3));
      replies.push({ code, text: lines[lines.length - 1].slice(0, 200) });
      buf = '';
      if (replies.length <= 3 && code >= 400) { sock.write('QUIT\r\n'); return done({ ok: true, replies, early: true }); }
      if (i >= steps.length) return done({ ok: true, replies });
      sock.write(`${steps[i++]}\r\n`);
    });
  });
}

// Resolver errors that say nothing about the domain itself (local resolver down, timeout, SERVFAIL).
export const TRANSIENT_DNS = new Set(['ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL', 'ECONNRESET', 'EREFUSED', 'ECANCELLED', 'EAI_AGAIN']);

// DNS-over-HTTPS fallback for machines whose system resolver is unreachable from Node.
async function doh(name, type) {
  const res = await fetchWithRetry(`https://cloudflare-dns.com/dns-query?${new URLSearchParams({ name, type })}`,
    { headers: { accept: 'application/dns-json' } }, { retries: 1, timeoutMs: 8000 });
  const j = await res.json();
  if (j.Status === 3) throw Object.assign(new Error(`${name} does not exist`), { code: 'ENOTFOUND' });
  if (j.Status !== 0) throw Object.assign(new Error(`DNS status ${j.Status}`), { code: 'ESERVFAIL' });
  const answers = (j.Answer || []).filter((a) => a.type === (type === 'MX' ? 15 : 1));
  if (!answers.length) throw Object.assign(new Error(`no ${type} records`), { code: 'ENODATA' });
  return answers.map((a) => a.data);
}

async function withDohFallback(native, name, type, map) {
  try {
    return await native(name);
  } catch (e) {
    if (!TRANSIENT_DNS.has(e.code)) throw e;
    return (await doh(name, type)).map(map);
  }
}

// External I/O seams. Production uses the real implementations; tests replace them.
export const runtime = {
  fetch: (...a) => globalThis.fetch(...a),
  dns: {
    resolveMx: (d) => withDohFallback((n) => dns.resolveMx(n), d, 'MX', (data) => {
      const [priority, host] = data.split(/\s+/);
      return { priority: Number(priority), exchange: host.replace(/\.$/, '') };
    }),
    resolve4: (d) => withDohFallback((n) => dns.resolve4(n), d, 'A', (data) => data),
  },
  createTransport: (opts) => nodemailer.createTransport(opts),
  smtpConversation,
  imapClientFactory: null, // set lazily in email/inbox.js
};

// fetch with a timeout and simple retry for transient failures (network errors, 429, 5xx).
export async function fetchWithRetry(url, opts = {}, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await runtime.fetch(url, { ...opts, signal: ctrl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastErr;
}

export async function fetchJson(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}
