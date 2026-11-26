import { config, PAID } from '../config.js';
import { one, all, run, nowIso, json } from '../db/index.js';
import { runtime, fetchJson } from '../lib/runtime.js';
import { getSettings } from '../lib/settings.js';
import { FREE_EMAIL_DOMAINS } from '../lib/text.js';

// Verification Agent. Layers, in order (all free by default):
// syntax -> suppression / previous bounce -> duplicate -> disposable -> system addresses -> DNS/MX
// -> SMTP mailbox probe (RCPT TO with a random-address control) -> optional paid provider (off in free-only mode).
//
// Statuses:
//   verified      mailbox confirmed (server accepted it AND rejected a random address, or a provider said valid)
//   likely_valid  mailbox not confirmed, but the business itself published it (FMCSA filing / own website) and the domain takes mail
//   risky         catch-all domain: the server accepts any address, so the mailbox cannot be confirmed
//   unknown       domain takes mail, mailbox could not be checked and there is no ownership evidence
//   invalid / disposable / duplicate / previously_bounced / suppressed
// An MX record alone never makes an address "verified".

const SYNTAX = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'getnada.com', 'throwawaymail.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'burnermail.io', 'spamgourmet.com',
  'mailnesia.com', 'mytemp.email', 'tempr.email', 'discard.email', 'moakt.com', 'inboxkitten.com',
]);
export const DISPOSABLE_LIST_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';

const ROLE_LOCALS = new Set(['info', 'contact', 'office', 'admin', 'sales', 'support', 'hello', 'dispatch', 'operations', 'ops',
  'billing', 'accounting', 'safety', 'hr', 'jobs', 'careers', 'mail', 'team', 'service', 'noreply', 'no-reply', 'webmaster', 'postmaster', 'abuse']);
const NEVER_SEND_LOCALS = /^(no-?reply|do-?not-?reply|postmaster|abuse|mailer-daemon|webmaster)$/;
const PROBE_BLOCK = /block|spamhaus|blacklist|reverse|rdns|ptr|policy|denied|reputation|5\.7\.|not allowed|refused/i;
const MAILBOX_GONE = /5\.1\.[0-9]|user unknown|no such user|nosuchuser|does not exist|mailbox (unavailable|not found)|recipient not found|address rejected/i;

export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

const isDisposable = (domain) => DISPOSABLE_DOMAINS.has(domain) || !!one('SELECT 1 FROM disposable_domains WHERE domain = ?', domain);

// Weekly refresh of the community-maintained disposable domain list (free, public).
export async function refreshDisposableDomains() {
  const res = await runtime.fetch(DISPOSABLE_LIST_URL);
  if (!res.ok) throw new Error(`disposable list HTTP ${res.status}`);
  const domains = (await res.text()).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && l.includes('.'));
  if (domains.length < 1000) throw new Error(`disposable list looks truncated (${domains.length} lines)`);
  run('DELETE FROM disposable_domains');
  const ins = 'INSERT OR IGNORE INTO disposable_domains (domain) VALUES (?)';
  for (const d of domains) run(ins, d);
  return { domains: domains.length };
}

// Who published this address? Evidence that the address belongs to the business.
export function ownershipEvidence(contact, company) {
  if (['fmcsa_census', 'fmcsa_authority'].includes(contact.source)) return 'fmcsa_registration';
  const domain = contact.email_normalized.split('@')[1];
  if (contact.source === 'website' && company?.domain && domain === company.domain) return 'own_website';
  if (contact.source === 'website') return 'website_listing';
  if (contact.source === 'manual' && contact.source_url) return 'manual_listing';
  return null;
}

async function dnsCheck(domain) {
  const out = { domain_exists: false, mx: [], has_a: false, null_mx: false, error: null };
  try {
    const mx = await runtime.dns.resolveMx(domain);
    out.mx = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    out.null_mx = mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.');
    out.domain_exists = true;
  } catch (e) {
    // Only an authoritative "no such domain / no records" answer is evidence. Resolver outages must not
    // mark an address invalid: throw so the job retries later.
    if (!['ENOTFOUND', 'ENODATA'].includes(e.code)) throw new Error(`DNS lookup failed for ${domain}: ${e.code || e.message}`);
    out.error = e.code;
    out.domain_exists = e.code === 'ENODATA';
  }
  if (!out.mx.length || out.null_mx) {
    try {
      out.has_a = (await runtime.dns.resolve4(domain)).length > 0;
      out.domain_exists ||= out.has_a;
    } catch (e) {
      if (!['ENOTFOUND', 'ENODATA'].includes(e.code)) throw new Error(`DNS lookup failed for ${domain}: ${e.code || e.message}`);
    }
  }
  return out;
}

// ---------- free SMTP mailbox probe ----------
const nextProbeAt = new Map();
async function paceHost(host) {
  const gap = config.verification.probeGapMs;
  const now = Date.now();
  const at = Math.max(now, nextProbeAt.get(host) || 0);
  nextProbeAt.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

function blockHost(host, reason, hours = 24) {
  run(`INSERT INTO mx_probe_state (host, blocked_until, reason, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET blocked_until = excluded.blocked_until, reason = excluded.reason, updated_at = excluded.updated_at`,
  host, new Date(Date.now() + hours * 3600000).toISOString(), String(reason).slice(0, 200), nowIso());
}

// Only a clean 250 for the address AND a 5xx for a random address on the same domain counts as mailbox evidence.
export async function smtpProbe(email, mxHost) {
  const paused = one('SELECT reason FROM mx_probe_state WHERE host = ? AND blocked_until > ?', mxHost, nowIso());
  if (paused) return { result: 'unknown', detail: `probing ${mxHost} paused: ${paused.reason}` };
  await paceHost(mxHost);
  const { smtpProbeHelo: helo, smtpProbeFrom: from } = config.verification;
  const domain = email.split('@')[1];
  const random = `zz-${Math.random().toString(36).slice(2, 12)}@${domain}`;
  const r = await runtime.smtpConversation(mxHost, [`EHLO ${helo}`, `MAIL FROM:<${from}>`, `RCPT TO:<${email}>`, `RCPT TO:<${random}>`, 'QUIT']);
  const rep = r.replies || [];
  const refused = rep.slice(0, 3).find((x) => x.code >= 400);
  if (refused || rep.length < 5) {
    const text = refused?.text || r.error || 'no response';
    // The server refuses to talk to this machine (blocklist, missing reverse DNS, port 25 blocked): back off for a day.
    if ((refused && PROBE_BLOCK.test(text)) || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(text)) blockHost(mxHost, text);
    return { result: 'unknown', detail: `could not check mailbox: ${text}` };
  }
  const target = rep[3];
  const control = rep[4];
  // Some servers (e.g. Outlook) refuse our IP at RCPT time with a 5.7.x policy code: that says nothing about the mailbox.
  if (target.code >= 500 && PROBE_BLOCK.test(target.text) && !MAILBOX_GONE.test(target.text)) {
    blockHost(mxHost, target.text);
    return { result: 'unknown', detail: `could not check mailbox: ${target.text}` };
  }
  if (target.code >= 500) return { result: 'rejected', detail: target.text };
  if (target.code >= 400) return { result: 'unknown', detail: `temporary answer (greylisting?): ${target.text}` };
  if (target.code === 250 && control.code >= 500) return { result: 'accepted', detail: 'mailbox accepted, random address rejected' };
  if (target.code === 250 && control.code === 250) return { result: 'catch_all', detail: 'server accepts any address' };
  return { result: 'unknown', detail: target.text };
}

// Paid mailbox verification APIs. Disabled in free-only mode (the default).
async function providerCheck(email) {
  const v = config.verification;
  if (v.zeroBounceKey && !(config.freeOnly && PAID.zeroBounce)) {
    const r = await fetchJson(`https://api.zerobounce.net/v2/validate?${new URLSearchParams({ api_key: v.zeroBounceKey, email, ip_address: '' })}`);
    const map = { valid: 'valid', invalid: 'invalid', 'catch-all': 'catch_all', unknown: 'unknown', spamtrap: 'invalid', abuse: 'invalid', do_not_mail: 'invalid' };
    return { provider: 'zerobounce', result: map[r.status] || 'unknown', raw: r.status, sub_status: r.sub_status || null };
  }
  if (v.neverBounceKey && !(config.freeOnly && PAID.neverBounce)) {
    const r = await fetchJson(`https://api.neverbounce.com/v4/single/check?${new URLSearchParams({ key: v.neverBounceKey, email })}`);
    const map = { valid: 'valid', invalid: 'invalid', disposable: 'disposable', catchall: 'catch_all', unknown: 'unknown' };
    return { provider: 'neverbounce', result: map[r.result] || 'unknown', raw: r.result };
  }
  return null;
}

// Pure decision from collected checks. Exported for testing.
export function decideStatus(c) {
  if (!c.syntax_ok) return { status: 'invalid', reason: 'Invalid email syntax' };
  if (c.suppressed === 'bounce' || c.previously_bounced) return { status: 'previously_bounced', reason: 'Hard-bounced before; never emailed again' };
  if (c.suppressed) return { status: 'suppressed', reason: `On suppression list (${c.suppressed})` };
  if (c.duplicate_of) return { status: 'duplicate', reason: `Same address already stored for contact #${c.duplicate_of}` };
  if (c.disposable || c.provider?.result === 'disposable') return { status: 'disposable', reason: 'Temporary/disposable email provider' };
  if (c.never_send_role) return { status: 'invalid', reason: 'System address that never reaches a person (noreply/postmaster)' };
  if (!c.dns.domain_exists) return { status: 'invalid', reason: `Domain does not exist (${c.dns.error || 'no DNS'})` };
  if (c.dns.null_mx || (!c.dns.mx.length && !c.dns.has_a)) return { status: 'invalid', reason: 'Domain does not accept email (no MX/A record)' };
  if (c.provider?.result === 'invalid') return { status: 'invalid', reason: `${c.provider.provider}: ${c.provider.raw}` };
  if (c.smtp?.result === 'rejected') return { status: 'invalid', reason: `Mail server rejected mailbox: ${c.smtp.detail}` };
  if (c.provider?.result === 'valid') return { status: 'verified', reason: `${c.provider.provider} confirmed the mailbox` };
  if (c.smtp?.result === 'accepted') return { status: 'verified', reason: 'Mail server accepted this mailbox and rejected a random one' };
  if (c.provider?.result === 'catch_all' || c.smtp?.result === 'catch_all') return { status: 'risky', reason: 'Catch-all domain: accepts any address, mailbox cannot be confirmed' };
  const why = c.smtp ? c.smtp.detail : 'mailbox check not run';
  if (c.ownership) {
    const by = { fmcsa_registration: 'the carrier\'s own FMCSA registration', own_website: 'the company\'s own website', website_listing: 'a website listing', manual_listing: 'a public listing you recorded' }[c.ownership];
    return { status: 'likely_valid', reason: `Published by ${by}; domain accepts mail; mailbox not confirmed (${why})` };
  }
  return { status: 'unknown', reason: `Domain accepts mail; mailbox not confirmed (${why})` };
}

export async function verifyContact(contactId) {
  const c = one('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!c) return null;
  const company = one('SELECT domain FROM companies WHERE id = ?', c.company_id);
  const email = c.email_normalized;
  const [local, domain] = email.split('@');
  const checks = {
    syntax_ok: SYNTAX.test(email),
    suppressed: one('SELECT reason FROM suppressions WHERE email_normalized = ?', email)?.reason || null,
    duplicate_of: one(`SELECT id FROM contacts WHERE email_normalized = ? AND id < ? AND duplicate_of IS NULL ORDER BY id LIMIT 1`, email, c.id)?.id || null,
    disposable: isDisposable(domain),
    is_role: ROLE_LOCALS.has(local),
    never_send_role: NEVER_SEND_LOCALS.test(local || ''),
    free_mail: FREE_EMAIL_DOMAINS.has(domain),
    previously_bounced: !!one(`SELECT 1 FROM email_events e JOIN contacts x ON x.id = e.contact_id WHERE x.email_normalized = ? AND e.type = 'bounced' LIMIT 1`, email),
    ownership: ownershipEvidence(c, company),
    dns: { domain_exists: false, mx: [], has_a: false, null_mx: false },
    smtp: null,
    provider: null,
    checked_at: nowIso(),
  };
  const early = !checks.syntax_ok || checks.suppressed || checks.duplicate_of || checks.disposable || checks.never_send_role || checks.previously_bounced;
  if (!early) {
    checks.dns = await dnsCheck(domain);
    if (checks.dns.mx.length && !checks.dns.null_mx) {
      try { checks.provider = await providerCheck(email); } catch (e) { checks.provider = { provider: 'error', result: 'unknown', raw: e.message.slice(0, 120) }; }
      if (config.verification.smtpProbe && checks.provider?.result !== 'valid') {
        checks.smtp = await smtpProbe(email, checks.dns.mx[0]);
      }
    }
  }
  const decision = decideStatus(checks);
  const provider = checks.provider && checks.provider.provider !== 'error' ? checks.provider.provider
    : checks.smtp && checks.smtp.result !== 'unknown' ? 'smtp_probe' : early ? 'rules' : 'dns';
  run(`UPDATE contacts SET verification_status = ?, verification_detail = ?, verification_provider = ?, ownership_evidence = ?, verified_at = ?, is_role = ?, duplicate_of = ? WHERE id = ?`,
    decision.status, JSON.stringify({ ...checks, reason: decision.reason }), provider, checks.ownership, nowIso(), checks.is_role ? 1 : 0, checks.duplicate_of, c.id);
  return { contactId, ...decision, checks };
}

// Is a contact allowed to receive outreach right now? Single gate used by the Outreach Agent.
export function sendable(contact, settings = getSettings()) {
  if (!contact) return { ok: false, why: 'contact missing' };
  if (one('SELECT 1 FROM suppressions WHERE email_normalized = ?', contact.email_normalized)) return { ok: false, why: 'suppressed' };
  const st = contact.verification_status;
  const allowedStatus = st === 'verified'
    || (st === 'likely_valid' && settings.allow_likely_valid_sends)
    || (['risky', 'unknown'].includes(st) && settings.allow_risky_sends);
  if (!allowedStatus) return { ok: false, why: `verification status ${st}` };
  if (contact.is_role && !settings.allow_role_addresses) return { ok: false, why: 'role address not allowed' };
  const ageDays = contact.verified_at ? (Date.now() - new Date(contact.verified_at).getTime()) / 86400000 : Infinity;
  if (ageDays > settings.recheck_after_days) return { ok: false, why: 'verification is stale', recheck: true };
  return { ok: true };
}

export function verificationSummary() {
  return all('SELECT verification_status status, COUNT(*) n FROM contacts GROUP BY verification_status');
}

export const detailOf = (c) => json(c.verification_detail, {});
