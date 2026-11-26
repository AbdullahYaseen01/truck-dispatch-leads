// Text helpers shared by the agents.

export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com',
  'ymail.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'me.com', 'mail.com', 'gmx.com',
  'protonmail.com', 'proton.me', 'bellsouth.net', 'charter.net', 'cox.net', 'yahoo.co', 'zoho.com',
]);

// Hosts whose pages are not a carrier's own website (social, directories, job boards, forums).
export const NON_COMPANY_HOSTS = [
  'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com',
  'reddit.com', 'yelp.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'bbb.org', 'mapquest.com',
  'yellowpages.com', 'manta.com', 'truckersreport.com', 'thetruckersreport.com', 'quora.com', 'craigslist.org',
  'google.com', 'safer.fmcsa.dot.gov', 'fmcsa.dot.gov', 'dot.gov', 'carriersource.io', 'wikipedia.org',
  'pinterest.com', 'nextdoor.com', 'trucksbook.com', 'amazon.com', 'dat.com', 'truckstop.com',
];
export const FORUM_HOSTS = ['reddit.com', 'truckersreport.com', 'thetruckersreport.com', 'quora.com', 'facebook.com'];

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function domainOfEmail(email) {
  return String(email).split('@')[1]?.toLowerCase() || null;
}

export function hostMatches(host, list) {
  return !!host && list.some((h) => host === h || host.endsWith(`.${h}`));
}

export function normalizeName(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|l l c|the|trucking|transport|transportation|logistics|express|freight|services?|group)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function phoneDigits(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
}

export function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Llc|Inc|Usa|Ltd)\b/g, (m) => m.toUpperCase());
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#64;|&commat;/g, '@').replace(/&#46;|&period;/g, '.')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;

// Emails that are literally published on a page: mailto links, plain text, and the common
// "name [at] domain [dot] com" obfuscation. Nothing is guessed.
export function extractEmails(html) {
  const found = new Set();
  const src = String(html || '');
  for (const m of src.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(decodeURIComponent(m[1]));
  const text = htmlToText(src)
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0]);
  for (const m of src.matchAll(EMAIL_RE)) found.add(m[0]);
  return [...found]
    .map((e) => e.trim().replace(/^[.]+|[.]+$/g, '').toLowerCase())
    .filter((e) => !ASSET_EXT.test(e) && !/@(example|domain|email|sentry|wixpress|sentry-next)\./.test(e) && e.length <= 254);
}

export function extractPhones(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) {
    out.add(`${m[1]}${m[2]}${m[3]}`);
  }
  return [...out];
}

export function extractDotMc(text) {
  const t = String(text || '');
  const dot = t.match(/\b(?:US\s?DOT|DOT)\s*(?:#|no\.?|number)?\s*:?\s*(\d{5,8})\b/i)?.[1] || null;
  const mc = t.match(/\bMC\s*(?:#|no\.?|number)?\s*:?\s*-?\s*(\d{5,7})\b/i)?.[1] || null;
  return { dot, mc };
}

// Sentences containing any of the given patterns; used to keep short evidence quotes.
export function evidenceSentences(text, patterns, max = 6) {
  const out = [];
  for (const s of String(text || '').split(/(?<=[.!?\n])\s+/)) {
    const t = s.trim();
    if (t.length < 8 || t.length > 400) continue;
    if (patterns.some((p) => p.test(t))) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export const daysAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);
