import { one, all, run, tx, nowIso, json } from '../db/index.js';
import { registerHandler, enqueue, PermanentError } from '../queue/queue.js';
import { audit, log } from '../lib/audit.js';
import { emit } from '../lib/events.js';
import { getSettings } from '../lib/settings.js';
import { daysAgo } from '../lib/text.js';
import { planQueries, SOURCE_FUNCTIONS, sourceAvailability, lookupAuthority, lookupCensusByDot } from './sources.js';
import { crawlSite } from './crawler.js';
import { upsertLead, addContact, addSource, dedupeSweep } from './leads.js';
import { verifyContact } from './verification.js';
import { qualifyCompany } from './qualification.js';
import { outreachTick } from './outreach.js';
import { processReply } from './replies.js';
import { pollAllInboxes } from '../email/inbox.js';
import { analyticsSnapshot } from './analytics.js';
import { researchCompany } from './research.js';
import { refreshDisposableDomains } from './verification.js';
import { dailyMaintenance } from '../lib/maintenance.js';

// Agents talk to each other through durable jobs:
// Research -> (Dedup on store) -> Email Discovery -> Verification -> Intent + Qualification -> Outreach -> Replies -> Conversion.

const RECRAWL_DAYS = 14;

export function startSearchRun(params, actor) {
  const avail = sourceAvailability();
  const clean = {
    sources: (params.sources || []).filter((s) => avail[s]),
    states: (params.states || []).map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)),
    cities: (params.cities || []).map((s) => String(s).trim()).filter(Boolean),
    equipment: (params.equipment || []).filter(Boolean),
    keywords: (params.keywords || []).map((s) => String(s).trim()).filter(Boolean),
    newWithinDays: Number(params.newWithinDays) || 120,
    maxFleet: Number(params.maxFleet) || 10,
    limitPerQuery: Math.min(Number(params.limitPerQuery) || 50, 500),
    maxQueries: Math.min(Number(params.maxQueries) || 40, 200),
  };
  const r = run(`INSERT INTO search_runs (schedule_id, params, created_by, created_at) VALUES (?, ?, ?, ?)`,
    params.scheduleId ?? null, JSON.stringify(clean), actor, nowIso());
  const id = Number(r.lastInsertRowid);
  enqueue('search.run', { runId: id }, { dedupeKey: `run:${id}` });
  audit(actor, 'search.start', 'search_run', id, clean);
  return id;
}

function bumpRun(runId, patch) {
  tx(() => {
    const r = one('SELECT stats FROM search_runs WHERE id = ?', runId);
    const s = json(r?.stats, {});
    for (const [k, v] of Object.entries(patch)) s[k] = (s[k] || 0) + v;
    const done = s.total !== undefined && (s.completed || 0) + (s.failed_queries || 0) >= s.total;
    run(`UPDATE search_runs SET stats = ?, status = CASE WHEN ? THEN 'done' ELSE status END, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      JSON.stringify(s), done ? 1 : 0, done ? 1 : 0, nowIso(), runId);
  });
  emit('search_run', { id: runId });
}

registerHandler('search.run', async ({ runId }) => {
  const r = one('SELECT * FROM search_runs WHERE id = ?', runId);
  if (!r) throw new PermanentError('run not found');
  const tasks = planQueries(json(r.params, {}));
  run(`UPDATE search_runs SET status = ?, started_at = ?, stats = ? WHERE id = ?`, tasks.length ? 'running' : 'done', nowIso(),
    JSON.stringify({ total: tasks.length, completed: 0, found: 0, new: 0, merged: 0 }), runId);
  if (!tasks.length) run(`UPDATE search_runs SET error = 'No configured sources match this search', finished_at = ? WHERE id = ?`, nowIso(), runId);
  // Each (source, query) is an independent job; workers run them in parallel.
  tasks.forEach((t, i) => enqueue('search.query', { runId, index: i, ...t }, { dedupeKey: `q:${runId}:${i}`, maxAttempts: 3 }));
  emit('search_run', { id: runId });
  return { tasks: tasks.length };
}, { maxAttempts: 2 });

registerHandler('search.query', async ({ runId, source, args }, job) => {
  const fn = SOURCE_FUNCTIONS[source];
  if (!fn) throw new PermanentError(`unknown source ${source}`);
  let leads;
  try {
    leads = await fn(args);
  } catch (e) {
    if (job.attempts >= job.max_attempts || (e.status && e.status < 500 && e.status !== 429)) {
      bumpRun(runId, { failed_queries: 1 });
      run(`UPDATE search_runs SET error = ? WHERE id = ?`, `${source}: ${e.message}`.slice(0, 500), runId);
      throw new PermanentError(e.message);
    }
    throw e;
  }
  let created = 0;
  let merged = 0;
  const query = args.query || `${source} ${args.state || ''}`.trim();
  for (const lead of leads) {
    const res = upsertLead(lead, { searchRunId: runId, query });
    if (res.created) created++; else merged++;
    enqueue('lead.enrich', { companyId: res.companyId }, { dedupeKey: `enrich:${res.companyId}` });
  }
  bumpRun(runId, { completed: 1, found: leads.length, new: created, merged });
  return { found: leads.length, created, merged };
});

// Email Discovery Agent: crawls the company's own website for published emails, phone, DOT/MC and
// activity evidence; looks up FMCSA authority when a DOT number is known.
registerHandler('lead.enrich', async ({ companyId }) => {
  let c = one('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c || c.duplicate_of) return { skipped: true };
  const out = { crawled: false, emails: 0 };
  const lastCrawl = one(`SELECT discovered_at FROM lead_sources WHERE company_id = ? AND source = 'website' ORDER BY discovered_at DESC LIMIT 1`, companyId);
  if (c.website && daysAgo(lastCrawl?.discovered_at) > RECRAWL_DAYS) {
    try {
      const site = await crawlSite(c.website);
      out.crawled = true;
      const now = nowIso();
      for (const e of site.emails) if (addContact(companyId, { email: e.email, source: 'website', source_url: e.source_url, contact_type: e.contact_type })) out.emails++;
      addSource(companyId, {
        source: 'website', source_url: site.pages[0]?.url || c.website, title: `Website crawl (${site.pages.length} pages${site.blocked ? ', blocked by robots.txt' : ''})`,
        snippet: site.text.slice(0, 4000) || null, published_at: site.latest_activity?.at || null,
      });
      run(`UPDATE companies SET phone = COALESCE(phone, ?), usdot_number = COALESCE(usdot_number, ?), mc_number = COALESCE(mc_number, ?),
          last_website_activity_at = COALESCE(?, last_website_activity_at), last_website_activity_evidence = COALESCE(?, last_website_activity_evidence),
          last_info_update_at = ?, updated_at = ? WHERE id = ?`,
      site.phones[0] || null, site.usdot_number, site.mc_number, site.latest_activity?.at || null, site.latest_activity?.evidence || null, now, now, companyId);
    } catch (e) {
      log.warn(`crawl failed for company ${companyId}: ${e.message}`);
    }
    c = one('SELECT * FROM companies WHERE id = ?', companyId);
  }
  // A DOT found on a website lets us pull the authoritative FMCSA record (fleet size, status, registration date).
  if (c.usdot_number && !one(`SELECT 1 FROM lead_sources WHERE company_id = ? AND source = 'fmcsa_census'`, companyId)) {
    try {
      const census = await lookupCensusByDot(c.usdot_number);
      if (census) upsertLead({ ...census, name: c.name, website: c.website });
    } catch (e) { log.warn(`census lookup failed for DOT ${c.usdot_number}: ${e.message}`); }
  }
  if (c.usdot_number && daysAgo(c.authority_checked_at) > 30) {
    try {
      const a = await lookupAuthority(c.usdot_number);
      // No authority record is normal for intrastate-only carriers: keep the census status, just remember we checked.
      run(`UPDATE companies SET operating_status = COALESCE(?, operating_status), mc_number = COALESCE(?, mc_number),
          authority_event = COALESCE(?, authority_event), authority_checked_at = ?, updated_at = ? WHERE id = ?`,
      a?.operating_status ?? null, a?.mc_number ?? null, a?.authority_event ? JSON.stringify(a.authority_event) : null, nowIso(), nowIso(), companyId);
    } catch (e) { log.warn(`authority lookup failed for DOT ${c.usdot_number}: ${e.message}`); }
  }
  for (const x of all(`SELECT id FROM contacts WHERE company_id = ? AND verification_status = 'unverified'`, companyId)) {
    enqueue('contact.verify', { contactId: x.id }, { dedupeKey: `verify:${x.id}` });
  }
  enqueue('lead.qualify', { companyId }, { dedupeKey: `qualify:${companyId}`, runAt: new Date(Date.now() + 2000).toISOString() });
  return out;
});

registerHandler('contact.verify', async ({ contactId }) => {
  const r = await verifyContact(contactId);
  if (!r) return null;
  const c = one('SELECT company_id FROM contacts WHERE id = ?', contactId);
  enqueue('lead.qualify', { companyId: c.company_id }, { dedupeKey: `qualify:${c.company_id}`, runAt: new Date(Date.now() + 2000).toISOString() });
  emit('contact', { id: contactId, status: r.status });
  return { status: r.status, reason: r.reason };
});

registerHandler('lead.qualify', async ({ companyId }) => {
  const r = await qualifyCompany(companyId);
  if (r) emit('lead', r);
  return r;
});

registerHandler('reply.classify', async ({ replyId, autoSubmitted }) => processReply(replyId, { autoSubmitted }));
registerHandler('outreach.tick', async () => outreachTick(), { maxAttempts: 1 });
registerHandler('inbox.poll', async () => pollAllInboxes(), { maxAttempts: 1 });
registerHandler('dedupe.sweep', async () => {
  const merged = dedupeSweep();
  if (merged) audit('dedup_agent', 'dedupe.sweep', null, null, { merged });
  return { merged };
}, { maxAttempts: 1 });
registerHandler('analytics.snapshot', async () => analyticsSnapshot(), { maxAttempts: 1 });
registerHandler('lead.research', async ({ companyId }) => researchCompany(companyId));
registerHandler('disposable.refresh', async () => refreshDisposableDomains(), { maxAttempts: 3 });
registerHandler('maintenance.daily', async () => dailyMaintenance(), { maxAttempts: 2 });

// Freshness engine: re-verify contacts older than the recheck window that are still candidates for outreach.
registerHandler('freshness.recheck', async () => {
  const s = getSettings();
  const cutoff = new Date(Date.now() - s.recheck_after_days * 86400000).toISOString();
  const rows = all(`SELECT x.id FROM contacts x JOIN companies c ON c.id = x.company_id
    WHERE x.verification_status IN ('verified','risky') AND (x.verified_at IS NULL OR x.verified_at < ?)
      AND c.stage IN ('new','qualified','contacted') LIMIT 500`, cutoff);
  for (const r of rows) enqueue('contact.verify', { contactId: r.id }, { dedupeKey: `verify:${r.id}` });
  return { queued: rows.length };
}, { maxAttempts: 1 });

// ---------- scheduler ----------
const PERIODIC = [
  ['outreach.tick', 60], ['inbox.poll', 120], ['dedupe.sweep', 3600], ['analytics.snapshot', 3600], ['freshness.recheck', 6 * 3600],
  ['disposable.refresh', 7 * 86400], ['maintenance.daily', 86400],
];

export function schedulerTick() {
  const now = nowIso();
  for (const s of all('SELECT * FROM search_schedules WHERE enabled = 1 AND next_run_at <= ?', now)) {
    const next = new Date(Date.now() + s.interval_minutes * 60000).toISOString();
    const claimed = run('UPDATE search_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ? AND next_run_at = ?', now, next, s.id, s.next_run_at);
    if (claimed.changes) startSearchRun({ ...json(s.params, {}), scheduleId: s.id }, `schedule:${s.name}`);
  }
  for (const [type, every] of PERIODIC) {
    const since = new Date(Date.now() - every * 1000).toISOString();
    if (!one('SELECT 1 FROM jobs WHERE type = ? AND created_at > ? LIMIT 1', type, since)) enqueue(type, {}, { dedupeKey: `periodic:${type}` });
  }
}

export function startScheduler() {
  schedulerTick();
  return setInterval(schedulerTick, 30000);
}
