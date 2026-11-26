import { config } from '../config.js';
import { one, run, nowIso } from '../db/index.js';
import { fetchWithRetry } from '../lib/runtime.js';
import { getSettings } from '../lib/settings.js';
import { htmlToText, extractEmails, extractPhones, extractDotMc, hostOf } from '../lib/text.js';

// Polite public-website crawler: honours robots.txt, fetches only a handful of pages per site,
// and records what it saw as evidence (never guesses).

const ROBOTS_TTL_DAYS = 7;

function parseRobots(body, ua) {
  // Collect Disallow rules for our UA (or *). Longest-match Allow overrides are supported.
  const groups = [];
  let cur = null;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if ((k === 'disallow' || k === 'allow') && cur) {
      cur.rules.push({ allow: k === 'allow', path: v });
    }
  }
  const token = ua.toLowerCase().split('/')[0];
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules).filter((r) => r.path !== '' || r.allow);
}

export function robotsAllows(body, ua, pathname) {
  const rules = parseRobots(body, ua);
  let best = null;
  for (const r of rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    if (new RegExp(`^${pattern}`).test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function robotsFor(origin) {
  const cached = one('SELECT * FROM robots_cache WHERE origin = ?', origin);
  if (cached && (Date.now() - new Date(cached.fetched_at).getTime()) / 86400000 < ROBOTS_TTL_DAYS) return cached;
  let body = '';
  let status = 0;
  try {
    const res = await fetchWithRetry(`${origin}/robots.txt`, { headers: { 'user-agent': config.sources.userAgent } }, { retries: 1, timeoutMs: 10000 });
    status = res.status;
    body = res.ok ? (await res.text()).slice(0, 100000) : '';
  } catch { status = 0; }
  run(`INSERT INTO robots_cache (origin, body, status, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(origin) DO UPDATE SET body = excluded.body, status = excluded.status, fetched_at = excluded.fetched_at`,
  origin, body, status, nowIso());
  return { origin, body, status };
}

async function fetchPage(url, respectRobots) {
  const u = new URL(url);
  if (respectRobots) {
    const robots = await robotsFor(u.origin);
    if (!robotsAllows(robots.body, config.sources.userAgent, u.pathname)) return { url, blocked: true };
  }
  const res = await fetchWithRetry(url, { headers: { 'user-agent': config.sources.userAgent, accept: 'text/html' }, redirect: 'follow' }, { retries: 1, timeoutMs: 15000 });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('html')) return { url, status: res.status, html: '' };
  const html = (await res.text()).slice(0, 1_500_000);
  return { url: res.url || url, status: res.status, html, lastModified: res.headers.get('last-modified') };
}

const CONTACT_LINK = /href=["']([^"'#]+)["'][^>]*>([^<]{0,60})</gi;
const CONTACT_WORDS = /contact|about|team|quote|dispatch|careers|reach/i;

function contactLinks(html, base) {
  const out = [];
  const baseHost = hostOf(base);
  for (const m of String(html).matchAll(CONTACT_LINK)) {
    if (!CONTACT_WORDS.test(m[1]) && !CONTACT_WORDS.test(m[2])) continue;
    try {
      const u = new URL(m[1], base);
      if (hostOf(u.href) === baseHost && /^https?:$/.test(u.protocol) && !out.includes(u.href)) out.push(u.href);
    } catch { /* skip bad href */ }
  }
  return out;
}

// Evidence of recent website activity: Last-Modified header, a copyright year, or a dated post.
function activityEvidence(page, text) {
  const ev = [];
  if (page.lastModified) {
    const d = new Date(page.lastModified);
    if (!Number.isNaN(d.getTime())) ev.push({ at: d.toISOString(), evidence: `Last-Modified header on ${page.url}` });
  }
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/gi)].map((m) => Number(m[1]));
  if (years.length) {
    const y = Math.max(...years);
    if (y <= new Date().getUTCFullYear()) ev.push({ at: `${y}-01-01T00:00:00.000Z`, evidence: `Copyright ${y} on ${page.url}` });
  }
  return ev;
}

export function classifyContactType(email) {
  const local = email.split('@')[0];
  if (/^(dispatch|loads?|booking)/.test(local)) return 'dispatch';
  if (/^(ops|operations)/.test(local)) return 'operations';
  if (/^(fleet|safety)/.test(local)) return 'fleet';
  if (/^(owner|ceo|president)/.test(local)) return 'owner';
  if (/^(info|contact|office|admin|hello|sales|support|mail)/.test(local)) return 'business';
  return 'business';
}

export async function crawlSite(website) {
  const s = getSettings();
  const start = website.startsWith('http') ? website : `https://${website}`;
  const host = hostOf(start);
  const pages = [];
  const queue = [start];
  const seen = new Set();
  while (queue.length && pages.length < s.max_pages_per_site) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let page;
    try { page = await fetchPage(url, s.respect_robots_txt); } catch (e) { pages.push({ url, error: e.message }); continue; }
    pages.push(page);
    if (page.html && pages.length === 1) queue.push(...contactLinks(page.html, page.url).slice(0, s.max_pages_per_site));
  }

  const emails = new Map();
  const phones = new Set();
  let dot = null;
  let mc = null;
  const activity = [];
  let text = '';
  for (const p of pages) {
    if (!p.html) continue;
    const t = htmlToText(p.html);
    text += `\n${t}`;
    for (const e of extractEmails(p.html)) if (!emails.has(e)) emails.set(e, { email: e, source_url: p.url, contact_type: classifyContactType(e) });
    for (const ph of extractPhones(t)) phones.add(ph);
    const ids = extractDotMc(t);
    dot ||= ids.dot;
    mc ||= ids.mc;
    activity.push(...activityEvidence(p, t));
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));
  return {
    host,
    pages: pages.map((p) => ({ url: p.url, status: p.status, blocked: !!p.blocked, error: p.error })),
    emails: [...emails.values()],
    phones: [...phones],
    usdot_number: dot,
    mc_number: mc,
    latest_activity: activity[0] || null,
    text: text.slice(0, 20000),
    blocked: pages.length > 0 && pages.every((p) => p.blocked),
  };
}
