import crypto from 'node:crypto';
import { one, all, run, tx, nowIso, json } from '../db/index.js';
import { config, integrationStatus } from '../config.js';
import { Router, HttpError } from './router.js';
import { login, logout, sessionCookie, createUser } from './auth.js';
import { audit } from '../lib/audit.js';
import { bus } from '../lib/events.js';
import { encrypt, readUnsubscribeToken } from '../lib/crypto.js';
import { getSettings, updateSettings, complianceProblems } from '../lib/settings.js';
import { enqueue, jobStats } from '../queue/queue.js';
import { sourceAvailability, EQUIPMENT_TYPES, PROSPECT_CATEGORIES } from '../agents/sources.js';
import { startSearchRun } from '../agents/pipeline.js';
import { upsertLead, addContact } from '../agents/leads.js';
import { verificationSummary } from '../agents/verification.js';
import {
  segmentWhere, createCampaign, setSteps, activateCampaign, campaignCandidates, approveMessage, rejectMessage,
  stopEnrollments, suppress, outreachTick, accountUsage, DEFAULT_SEQUENCE,
} from '../agents/outreach.js';
import { processReply, applyClassification, REPLY_CATEGORIES, latestReplyText } from '../agents/replies.js';
import { draftConversionReply, recordMeeting, markClient } from '../agents/conversion.js';
import { overviewStats, timeseries, breakdowns, latestInsights, analyticsSnapshot, agentActivity } from '../agents/analytics.js';
import { VERIFICATION_STATUSES } from '../agents/constants.js';
import { SOURCE_COST } from '../agents/sources.js';
import { llmBudgetLeft } from '../lib/llm.js';
import { researchCompany } from '../agents/research.js';
import { verifyAccount } from '../email/mailer.js';
import { handleRawMessage } from '../email/inbox.js';
import { ingestInbound } from '../agents/replies.js';

export const api = new Router();
const admin = { role: 'admin' };
const pub = { public: true };

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };

function leadRow(c) {
  return {
    ...c,
    equipment_types: json(c.equipment_types, []),
    intent_signals: json(c.intent_signals, []),
    lead_score_breakdown: json(c.lead_score_breakdown, {}),
  };
}

// ---------------- auth ----------------
api.add('POST', '/api/login', async ({ req, body, res }) => {
  const { token, user } = login(req, body.email, body.password);
  audit(user.email, 'auth.login', 'user', user.id);
  res.setHeader('set-cookie', sessionCookie(token));
  return { user: { email: user.email, name: user.name, role: user.role } };
}, pub);

api.add('POST', '/api/logout', async ({ req, res }) => {
  logout(req);
  res.setHeader('set-cookie', sessionCookie('', 0));
  return { ok: true };
});

api.add('GET', '/api/me', async ({ user }) => ({ user }));

api.add('GET', '/api/users', async () => ({ users: all('SELECT id, email, name, role, created_at FROM users ORDER BY id') }), admin);
api.add('POST', '/api/users', async ({ body, user }) => {
  need(!one('SELECT 1 FROM users WHERE email = ?', String(body.email || '').toLowerCase().trim()), 'User already exists', 409);
  const id = createUser(body);
  audit(user.email, 'user.create', 'user', id, { email: body.email, role: body.role });
  return { id };
}, admin);

// ---------------- overview & analytics ----------------
api.add('GET', '/api/overview', async ({ query }) => ({
  stats: overviewStats(),
  series: timeseries(int(query.days, 30)),
  insights: latestInsights(),
  compliance: complianceProblems(),
  jobs: jobStats(),
  notifications: all('SELECT * FROM notifications ORDER BY id DESC LIMIT 15'),
}));

api.add('GET', '/api/analytics', async ({ query }) => ({
  stats: overviewStats(), series: timeseries(int(query.days, 30)), breakdowns: breakdowns(), insights: latestInsights(), activity: agentActivity(),
}));
api.add('GET', '/api/agents', async () => ({ ...agentActivity(), ai_budget_left: llmBudgetLeft() }));
api.add('POST', '/api/analytics/refresh', async () => { await analyticsSnapshot(); return latestInsights(); }, admin);

api.add('GET', '/api/notifications', async () => ({ notifications: all('SELECT * FROM notifications ORDER BY id DESC LIMIT 100') }));
api.add('POST', '/api/notifications/read', async () => { run('UPDATE notifications SET is_read = 1 WHERE is_read = 0'); return { ok: true }; });

api.add('GET', '/api/audit', async ({ query }) => ({
  entries: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', Math.min(int(query.limit, 100), 500), int(query.offset, 0)),
}));

api.add('GET', '/api/jobs', async () => ({
  stats: jobStats(),
  recent_failures: all(`SELECT id, type, attempts, last_error, updated_at FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20`),
}));

api.add('GET', '/api/meta', async () => ({
  equipment: EQUIPMENT_TYPES, categories: PROSPECT_CATEGORIES, sources: sourceAvailability(), source_cost: SOURCE_COST, reply_categories: REPLY_CATEGORIES,
  verification_statuses: VERIFICATION_STATUSES,
  states: all(`SELECT DISTINCT state FROM companies WHERE state IS NOT NULL ORDER BY state`).map((r) => r.state),
  stages: ['new', 'qualified', 'disqualified', 'contacted', 'replied', 'interested', 'meeting', 'client', 'not_interested', 'do_not_contact'],
}));

// ---------------- lead discovery ----------------
api.add('GET', '/api/search-runs', async () => ({
  runs: all('SELECT * FROM search_runs ORDER BY id DESC LIMIT 50').map((r) => ({ ...r, params: json(r.params, {}), stats: json(r.stats, {}) })),
  sources: sourceAvailability(),
}));

api.add('POST', '/api/search-runs', async ({ body, user }) => {
  const params = {
    sources: list(body.sources), states: list(body.states), cities: list(body.cities), equipment: list(body.equipment),
    keywords: (Array.isArray(body.keywords) ? body.keywords : String(body.keywords || '').split('\n')).map((s) => String(s).trim()).filter(Boolean),
    newWithinDays: body.newWithinDays, maxFleet: body.maxFleet, limitPerQuery: body.limitPerQuery, maxQueries: body.maxQueries,
  };
  need(params.sources.length, 'Choose at least one source');
  const id = startSearchRun(params, user.email);
  return { id };
}, admin);

api.add('GET', '/api/schedules', async () => ({
  schedules: all('SELECT * FROM search_schedules ORDER BY id').map((s) => ({ ...s, params: json(s.params, {}) })),
}));

api.add('POST', '/api/schedules', async ({ body, user }) => {
  need(body.name, 'Name is required');
  const minutes = int(body.interval_minutes, 0);
  need(minutes >= 30, 'Interval must be at least 30 minutes');
  const params = { sources: list(body.sources), states: list(body.states), cities: list(body.cities), equipment: list(body.equipment),
    newWithinDays: body.newWithinDays, maxFleet: body.maxFleet, limitPerQuery: body.limitPerQuery, maxQueries: body.maxQueries };
  need(params.sources.length, 'Choose at least one source');
  const r = run('INSERT INTO search_schedules (name, params, interval_minutes, next_run_at, created_at) VALUES (?, ?, ?, ?, ?)',
    body.name, JSON.stringify(params), minutes, nowIso(), nowIso());
  audit(user.email, 'schedule.create', 'schedule', Number(r.lastInsertRowid), { name: body.name, minutes });
  return { id: Number(r.lastInsertRowid) };
}, admin);

api.add('PATCH', '/api/schedules/:id', async ({ params, body, user }) => {
  need(one('SELECT 1 FROM search_schedules WHERE id = ?', params.id), 'Not found', 404);
  if (body.enabled !== undefined) run('UPDATE search_schedules SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, params.id);
  if (body.interval_minutes !== undefined) { need(int(body.interval_minutes, 0) >= 30, 'Interval must be at least 30 minutes'); run('UPDATE search_schedules SET interval_minutes = ? WHERE id = ?', int(body.interval_minutes, 0), params.id); }
  audit(user.email, 'schedule.update', 'schedule', Number(params.id), body);
  return { ok: true };
}, admin);

api.add('DELETE', '/api/schedules/:id', async ({ params, user }) => {
  run('DELETE FROM search_schedules WHERE id = ?', params.id);
  audit(user.email, 'schedule.delete', 'schedule', Number(params.id));
  return { ok: true };
}, admin);

// ---------------- lead database ----------------
const SORTS = { confidence: 'c.confidence_score', lead_score: 'c.lead_score', intent_score: 'c.intent_score', freshness: 'c.freshness_score', discovered: 'c.first_discovered_at', name: 'c.name', fleet: 'c.fleet_size' };

export function segmentFromQuery(q) {
  return {
    states: list(q.states || q.state), stages: list(q.stages || q.stage), categories: list(q.categories || q.category),
    equipment: list(q.equipment), min_lead_score: q.min_lead_score, min_intent: q.min_intent, max_fleet: q.max_fleet,
    min_fleet: q.min_fleet, city: q.city, source: q.source, verification: q.verification, from: q.from, to: q.to, q: q.q,
    campaign_status: q.campaign_status, campaign_id: q.campaign_id, priority: q.priority, eligible: q.eligible, recent_days: q.recent_days,
    has_mc: q.has_mc, zip: q.zip,
  };
}

api.add('GET', '/api/leads', async ({ query }) => {
  const params = [];
  const where = segmentWhere(segmentFromQuery(query), params);
  const sort = SORTS[query.sort] || 'c.lead_score';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(int(query.limit, 50), 200);
  const offset = int(query.offset, 0);
  const total = one(`SELECT COUNT(*) n FROM companies c WHERE ${where}`, ...params).n;
  const rows = all(`SELECT c.*,
      (SELECT x.email FROM contacts x WHERE x.company_id = c.id AND x.verification_status IN ('verified','risky') ORDER BY CASE x.verification_status WHEN 'verified' THEN 0 ELSE 1 END, x.id LIMIT 1) best_email,
      (SELECT x.verification_status FROM contacts x WHERE x.company_id = c.id AND x.verification_status IN ('verified','risky') ORDER BY CASE x.verification_status WHEN 'verified' THEN 0 ELSE 1 END, x.id LIMIT 1) best_email_status,
      (SELECT COUNT(*) FROM contacts x WHERE x.company_id = c.id) contact_count,
      (SELECT GROUP_CONCAT(DISTINCT s.source) FROM lead_sources s WHERE s.company_id = c.id) sources
    FROM companies c WHERE ${where} ORDER BY ${sort} ${dir} NULLS LAST, c.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { total, leads: rows.map(leadRow) };
});

api.add('GET', '/api/leads/export.csv', async ({ query, res }) => {
  const params = [];
  const where = segmentWhere(segmentFromQuery(query), params);
  const rows = all(`SELECT c.*, (SELECT x.email FROM contacts x WHERE x.company_id = c.id AND x.verification_status IN ('verified','risky') ORDER BY CASE x.verification_status WHEN 'verified' THEN 0 ELSE 1 END LIMIT 1) best_email
    FROM companies c WHERE ${where} ORDER BY c.lead_score DESC LIMIT 10000`, ...params);
  // fields=mc_zip: just the identifiers (MC number, ZIP code) with enough context to tell carriers apart.
  const brief = query.fields === 'mc_zip';
  const cols = brief ? ['name', 'mc_number', 'zip_code', 'state', 'city', 'usdot_number', 'authority_granted_at']
    : ['id', 'name', 'mc_number', 'zip_code', 'owner_name', 'best_email', 'phone', 'website', 'city', 'state', 'equipment_types', 'fleet_size', 'usdot_number', 'operating_status', 'intent_score', 'lead_score', 'freshness_score', 'stage', 'first_discovered_at', 'dispatch_need'];
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[\",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const show = (r, k) => (k === 'mc_number' && r[k] ? `MC${r[k]}` : k === 'authority_granted_at' && r[k] ? String(r[k]).slice(0, 10) : r[k]);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => esc(show(r, k))).join(','))].join('\n');
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${brief ? 'mc-zip' : 'leads'}.csv"` });
  res.end(csv);
  return undefined;
});

api.add('GET', '/api/leads/:id', async ({ params }) => {
  const c = one('SELECT * FROM companies WHERE id = ?', params.id);
  need(c, 'Lead not found', 404);
  return {
    lead: { ...leadRow(c), eligibility: json(c.eligibility, {}), authority_event: json(c.authority_event, null), fleet_history: json(c.fleet_history, []) },
    contacts: all('SELECT * FROM contacts WHERE company_id = ? ORDER BY id', c.id).map((x) => ({ ...x, verification_detail: json(x.verification_detail, {}) })),
    sources: all('SELECT id, source, source_url, query, title, substr(snippet, 1, 600) snippet, published_at, discovered_at FROM lead_sources WHERE company_id = ? ORDER BY discovered_at DESC', c.id),
    enrollments: all('SELECT e.*, k.name campaign_name FROM enrollments e JOIN campaigns k ON k.id = e.campaign_id WHERE e.company_id = ?', c.id),
    messages: all('SELECT id, kind, step_number, status, subject, body_text, to_email, generated_by, sent_at, created_at FROM messages WHERE company_id = ? ORDER BY id', c.id),
    replies: all('SELECT * FROM replies WHERE company_id = ? ORDER BY id', c.id),
    duplicates: all('SELECT id, name FROM companies WHERE duplicate_of = ?', c.id),
    meetings: all('SELECT * FROM meetings WHERE company_id = ?', c.id),
  };
});

api.add('POST', '/api/leads', async ({ body, user }) => {
  need(body.name, 'Company name is required');
  const lead = {
    name: String(body.name).trim(), website: body.website || null, phone: body.phone || null, city: body.city || null,
    state: body.state ? String(body.state).toUpperCase() : null, country: body.country ? String(body.country).toUpperCase() : 'US',
    equipment_types: list(body.equipment_types), fleet_size: int(body.fleet_size, null), usdot_number: body.usdot_number || null,
    owner_name: body.owner_name || null, prospect_category: body.prospect_category || null,
    emails: body.email ? [{ email: body.email, source_url: body.source_url || null, contact_type: body.contact_type || 'business' }] : [],
    source: 'manual', source_url: body.source_url || `manual:${user.email}:${Date.now()}`, title: 'Added manually', snippet: body.notes || null,
  };
  const r = upsertLead(lead);
  enqueue('lead.enrich', { companyId: r.companyId }, { dedupeKey: `enrich:${r.companyId}` });
  audit(user.email, 'lead.create', 'company', r.companyId, { created: r.created, mergedBy: r.mergedBy });
  return r;
}, admin);

api.add('PATCH', '/api/leads/:id', async ({ params, body, user }) => {
  const c = one('SELECT * FROM companies WHERE id = ?', params.id);
  need(c, 'Lead not found', 404);
  if (body.stage) {
    need(['new', 'qualified', 'disqualified', 'contacted', 'replied', 'interested', 'meeting', 'client', 'not_interested', 'do_not_contact'].includes(body.stage), 'Invalid stage');
    if (body.stage === 'client') markClient(c.id, user.email);
    else {
      run('UPDATE companies SET stage = ?, updated_at = ? WHERE id = ?', body.stage, nowIso(), c.id);
      if (['do_not_contact', 'not_interested', 'disqualified'].includes(body.stage)) stopEnrollments({ companyId: c.id }, `stage set to ${body.stage}`);
      if (body.stage === 'do_not_contact') for (const x of all('SELECT email FROM contacts WHERE company_id = ?', c.id)) suppress(x.email, 'do_not_contact', user.email);
    }
  }
  if (body.lawful_basis !== undefined) run('UPDATE companies SET lawful_basis = ? WHERE id = ?', String(body.lawful_basis || '').trim() || null, c.id);
  audit(user.email, 'lead.update', 'company', c.id, body);
  return { ok: true };
}, admin);

api.add('POST', '/api/leads/:id/enrich', async ({ params, user }) => {
  need(one('SELECT 1 FROM companies WHERE id = ?', params.id), 'Lead not found', 404);
  run(`DELETE FROM lead_sources WHERE company_id = ? AND source = 'website'`, params.id); // forces a fresh crawl
  enqueue('lead.enrich', { companyId: Number(params.id) }, { dedupeKey: `enrich:${params.id}` });
  audit(user.email, 'lead.enrich', 'company', Number(params.id));
  return { queued: true };
}, admin);

api.add('POST', '/api/leads/:id/research', async ({ params, user }) => {
  need(one('SELECT 1 FROM companies WHERE id = ?', params.id), 'Lead not found', 404);
  run('UPDATE companies SET research_hash = NULL WHERE id = ?', params.id); // force a rebuild
  const r = await researchCompany(Number(params.id));
  audit(user.email, 'lead.research', 'company', Number(params.id));
  return r;
}, admin);

api.add('POST', '/api/leads/:id/contacts', async ({ params, body, user }) => {
  need(one('SELECT 1 FROM companies WHERE id = ?', params.id), 'Lead not found', 404);
  need(body.email && body.source_url, 'Email and the public URL where it is listed are required');
  const id = addContact(Number(params.id), { email: body.email, source: 'manual', source_url: body.source_url, contact_type: body.contact_type || 'business', name: body.name || null });
  need(id, 'This email already exists on the lead', 409);
  enqueue('contact.verify', { contactId: id }, { dedupeKey: `verify:${id}` });
  audit(user.email, 'contact.add', 'contact', id, { email: body.email });
  return { id };
}, admin);

// ---------------- email verification ----------------
api.add('GET', '/api/contacts', async ({ query }) => {
  const w = ['1=1'];
  const p = [];
  if (query.status) { w.push('x.verification_status = ?'); p.push(query.status); }
  if (query.q) { w.push('(x.email LIKE ? OR c.name LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
  const limit = Math.min(int(query.limit, 50), 200);
  return {
    summary: verificationSummary(),
    total: one(`SELECT COUNT(*) n FROM contacts x JOIN companies c ON c.id = x.company_id WHERE ${w.join(' AND ')}`, ...p).n,
    contacts: all(`SELECT x.*, c.name company_name FROM contacts x JOIN companies c ON c.id = x.company_id WHERE ${w.join(' AND ')}
      ORDER BY x.id DESC LIMIT ? OFFSET ?`, ...p, limit, int(query.offset, 0)).map((x) => ({ ...x, verification_detail: json(x.verification_detail, {}) })),
    suppressions: one('SELECT COUNT(*) n FROM suppressions').n,
  };
});

api.add('POST', '/api/contacts/:id/verify', async ({ params, user }) => {
  need(one('SELECT 1 FROM contacts WHERE id = ?', params.id), 'Contact not found', 404);
  enqueue('contact.verify', { contactId: Number(params.id) }, { dedupeKey: `verify:${params.id}` });
  audit(user.email, 'contact.reverify', 'contact', Number(params.id));
  return { queued: true };
}, admin);

api.add('POST', '/api/contacts/reverify', async ({ body, user }) => {
  const statuses = list(body.statuses).filter((s) => ['unverified', 'risky', 'unknown', 'likely_valid', 'verified'].includes(s));
  need(statuses.length, 'Choose statuses to re-verify');
  const rows = all(`SELECT id FROM contacts WHERE verification_status IN (${statuses.map(() => '?').join(',')}) LIMIT 2000`, ...statuses);
  for (const r of rows) enqueue('contact.verify', { contactId: r.id }, { dedupeKey: `verify:${r.id}` });
  audit(user.email, 'contact.reverify_bulk', null, null, { statuses, count: rows.length });
  return { queued: rows.length };
}, admin);

api.add('GET', '/api/suppressions', async () => ({ suppressions: all('SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500') }));
api.add('POST', '/api/suppressions', async ({ body, user }) => {
  need(/^[^@\s]+@[^@\s]+$/.test(String(body.email || '').trim()), 'Valid email required');
  suppress(body.email, 'manual', user.email);
  audit(user.email, 'suppression.add', null, null, { email: body.email });
  return { ok: true };
}, admin);

// ---------------- templates ----------------
const PURPOSES = ['intro', 'followup', 'benefits', 'final', 'reply_interested', 'reply_pricing', 'reply_info'];
api.add('GET', '/api/templates', async () => ({ templates: all('SELECT * FROM templates ORDER BY purpose, id') }));
api.add('POST', '/api/templates', async ({ body, user }) => {
  need(body.name && body.subject && body.body && PURPOSES.includes(body.purpose), 'Name, purpose, subject and body are required');
  const r = run('INSERT INTO templates (name, purpose, subject, body, ai_guidance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    body.name, body.purpose, body.subject, body.body, body.ai_guidance || null, nowIso(), nowIso());
  audit(user.email, 'template.create', 'template', Number(r.lastInsertRowid));
  return { id: Number(r.lastInsertRowid) };
}, admin);
api.add('PUT', '/api/templates/:id', async ({ params, body, user }) => {
  need(one('SELECT 1 FROM templates WHERE id = ?', params.id), 'Not found', 404);
  need(body.name && body.subject && body.body && PURPOSES.includes(body.purpose), 'Name, purpose, subject and body are required');
  run('UPDATE templates SET name = ?, purpose = ?, subject = ?, body = ?, ai_guidance = ?, updated_at = ? WHERE id = ?',
    body.name, body.purpose, body.subject, body.body, body.ai_guidance || null, nowIso(), params.id);
  audit(user.email, 'template.update', 'template', Number(params.id));
  return { ok: true };
}, admin);
api.add('DELETE', '/api/templates/:id', async ({ params, user }) => {
  need(!one('SELECT 1 FROM campaign_steps WHERE template_id = ?', params.id), 'Template is used by a campaign step', 409);
  run('DELETE FROM templates WHERE id = ?', params.id);
  audit(user.email, 'template.delete', 'template', Number(params.id));
  return { ok: true };
}, admin);

// ---------------- campaigns ----------------
function campaignView(k) {
  return {
    ...k, segment: json(k.segment, {}), sending_account_ids: json(k.sending_account_ids, []),
    steps: all('SELECT s.*, t.name template_name FROM campaign_steps s LEFT JOIN templates t ON t.id = s.template_id WHERE campaign_id = ? ORDER BY step_number', k.id)
      .map((s) => ({ ...s, variant_template_ids: json(s.variant_template_ids, []) })),
    counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY status', k.id).map((r) => [r.status, r.n])),
    messages: Object.fromEntries(all('SELECT status, COUNT(*) n FROM messages WHERE campaign_id = ? GROUP BY status', k.id).map((r) => [r.status, r.n])),
    replies: one('SELECT COUNT(*) n FROM replies r JOIN messages m ON m.id = r.message_id WHERE m.campaign_id = ?', k.id).n,
  };
}

api.add('GET', '/api/campaigns', async () => ({ campaigns: all('SELECT * FROM campaigns ORDER BY id DESC').map(campaignView), compliance: complianceProblems() }));
api.add('GET', '/api/campaigns/:id', async ({ params }) => {
  const k = one('SELECT * FROM campaigns WHERE id = ?', params.id);
  need(k, 'Campaign not found', 404);
  return { campaign: campaignView(k) };
});

function cleanSteps(steps) {
  const s = Array.isArray(steps) && steps.length ? steps : DEFAULT_SEQUENCE;
  return s.map((x) => ({ purpose: PURPOSES.slice(0, 4).includes(x.purpose) ? x.purpose : 'followup', day_offset: Math.max(0, int(x.day_offset, 0)),
    template_id: x.template_id ? int(x.template_id, null) : null, variant_template_ids: list(x.variant_template_ids).map((v) => int(v, 0)).filter(Boolean).slice(0, 3) }));
}

api.add('POST', '/api/campaigns', async ({ body, user }) => {
  need(body.name, 'Campaign name is required');
  const id = createCampaign({
    name: body.name, segment: body.segment || {}, require_approval: body.require_approval !== false,
    sending_account_ids: (body.sending_account_ids || []).map(Number), steps: cleanSteps(body.steps),
  }, user.email);
  return { id };
}, admin);

api.add('PUT', '/api/campaigns/:id', async ({ params, body, user }) => {
  const k = one('SELECT * FROM campaigns WHERE id = ?', params.id);
  need(k, 'Campaign not found', 404);
  tx(() => {
    run('UPDATE campaigns SET name = ?, segment = ?, require_approval = ?, sending_account_ids = ?, updated_at = ? WHERE id = ?',
      body.name || k.name, JSON.stringify(body.segment ?? json(k.segment, {})), body.require_approval === false ? 0 : 1,
      JSON.stringify((body.sending_account_ids ?? json(k.sending_account_ids, [])).map(Number)), nowIso(), k.id);
    if (body.steps) setSteps(k.id, cleanSteps(body.steps));
  });
  audit(user.email, 'campaign.update', 'campaign', k.id);
  return { ok: true };
}, admin);

api.add('GET', '/api/campaigns/:id/preview', async ({ params }) => {
  need(one('SELECT 1 FROM campaigns WHERE id = ?', params.id), 'Campaign not found', 404);
  const { candidates, skipped } = campaignCandidates(Number(params.id), { limit: 500 });
  return {
    count: candidates.length, skipped,
    sample: candidates.slice(0, 25).map(({ company, contact }) => ({ id: company.id, name: company.name, state: company.state, lead_score: company.lead_score, intent_score: company.intent_score, email: contact.email, status: contact.verification_status })),
  };
});

api.add('POST', '/api/campaigns/:id/activate', async ({ params, user }) => {
  const r = activateCampaign(Number(params.id), user.email);
  need(r.ok, (r.problems || []).join(' '));
  enqueue('outreach.tick', {}, { dedupeKey: 'periodic:outreach.tick' });
  return r;
}, admin);

api.add('POST', '/api/campaigns/:id/pause', async ({ params, user }) => {
  run(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`, nowIso(), params.id);
  audit(user.email, 'campaign.pause', 'campaign', Number(params.id));
  return { ok: true };
}, admin);

api.add('POST', '/api/campaigns/:id/complete', async ({ params, user }) => {
  tx(() => {
    run(`UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ?`, nowIso(), params.id);
    for (const e of all(`SELECT contact_id FROM enrollments WHERE campaign_id = ? AND status = 'active'`, params.id)) stopEnrollments({ contactId: e.contact_id }, 'campaign completed');
  });
  audit(user.email, 'campaign.complete', 'campaign', Number(params.id));
  return { ok: true };
}, admin);

// ---------------- messages (approval queue) ----------------
api.add('GET', '/api/messages', async ({ query }) => {
  const w = ['1=1'];
  const p = [];
  if (query.status) { w.push('m.status = ?'); p.push(query.status); }
  if (query.kind) { w.push('m.kind = ?'); p.push(query.kind); }
  if (query.campaign_id) { w.push('m.campaign_id = ?'); p.push(int(query.campaign_id, 0)); }
  return {
    messages: all(`SELECT m.*, c.name company_name, c.intent_score, c.lead_score FROM messages m LEFT JOIN companies c ON c.id = m.company_id
      WHERE ${w.join(' AND ')} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...p, Math.min(int(query.limit, 50), 200), int(query.offset, 0))
      .map((m) => ({ ...m, personalization_facts: json(m.personalization_facts, []) })),
    counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM messages GROUP BY status').map((r) => [r.status, r.n])),
  };
});

api.add('PUT', '/api/messages/:id', async ({ params, body, user }) => {
  const m = one('SELECT * FROM messages WHERE id = ?', params.id);
  need(m, 'Message not found', 404);
  need(m.status === 'pending_approval', 'Only messages waiting for approval can be edited', 409);
  need(String(body.subject || '').trim() && String(body.body_text || '').trim(), 'Subject and body are required');
  run('UPDATE messages SET subject = ?, body_text = ?, updated_at = ? WHERE id = ?', String(body.subject).trim(), String(body.body_text).trim(), nowIso(), m.id);
  audit(user.email, 'message.edit', 'message', m.id);
  return { ok: true };
}, admin);

api.add('POST', '/api/messages/:id/approve', async ({ params, user }) => {
  need(complianceProblems().length === 0, complianceProblems().join(' '));
  need(approveMessage(Number(params.id), user.email), 'Message is not waiting for approval', 409);
  return { ok: true };
}, admin);

api.add('POST', '/api/messages/:id/reject', async ({ params, user }) => {
  need(rejectMessage(Number(params.id), user.email), 'Message is not waiting for approval', 409);
  return { ok: true };
}, admin);

api.add('POST', '/api/messages/approve-all', async ({ body, user }) => {
  need(complianceProblems().length === 0, complianceProblems().join(' '));
  const ids = (body.ids || []).map(Number).filter(Boolean);
  need(ids.length, 'No messages selected');
  let n = 0;
  for (const id of ids) if (approveMessage(id, user.email)) n++;
  return { approved: n };
}, admin);

api.add('POST', '/api/outreach/run', async ({ body, user }) => {
  const r = await outreachTick({ ignoreWindow: !!body.ignoreWindow });
  audit(user.email, 'outreach.run', null, null, r);
  return r;
}, admin);

// ---------------- follow-up management ----------------
api.add('GET', '/api/enrollments', async ({ query }) => {
  const w = ['1=1'];
  const p = [];
  if (query.status) { w.push('e.status = ?'); p.push(query.status); }
  if (query.campaign_id) { w.push('e.campaign_id = ?'); p.push(int(query.campaign_id, 0)); }
  return {
    enrollments: all(`SELECT e.*, c.name company_name, x.email, k.name campaign_name,
        (SELECT COUNT(*) FROM campaign_steps s WHERE s.campaign_id = e.campaign_id) total_steps
      FROM enrollments e JOIN companies c ON c.id = e.company_id JOIN contacts x ON x.id = e.contact_id JOIN campaigns k ON k.id = e.campaign_id
      WHERE ${w.join(' AND ')} ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.next_send_at LIMIT ? OFFSET ?`, ...p, Math.min(int(query.limit, 100), 300), int(query.offset, 0)),
    counts: Object.fromEntries(all('SELECT status, COUNT(*) n FROM enrollments GROUP BY status').map((r) => [r.status, r.n])),
    due_today: one(`SELECT COUNT(*) n FROM enrollments WHERE status = 'active' AND next_send_at <= ?`, new Date(Date.now() + 86400000).toISOString()).n,
  };
});

api.add('POST', '/api/enrollments/:id/stop', async ({ params, user }) => {
  const e = one('SELECT * FROM enrollments WHERE id = ?', params.id);
  need(e, 'Not found', 404);
  stopEnrollments({ contactId: e.contact_id }, `stopped by ${user.email}`);
  audit(user.email, 'enrollment.stop', 'enrollment', e.id);
  return { ok: true };
}, admin);

// ---------------- AI reply management ----------------
api.add('GET', '/api/replies', async ({ query }) => {
  const w = ['1=1'];
  const p = [];
  if (query.classification) { w.push('r.classification = ?'); p.push(query.classification); }
  if (query.needs_admin === '1') w.push('r.needs_admin = 1 AND r.handled = 0');
  if (query.unhandled === '1') w.push('r.handled = 0');
  return {
    replies: all(`SELECT r.*, c.name company_name, c.stage, m.subject original_subject,
        (SELECT d.id FROM messages d WHERE d.reply_id = r.id ORDER BY d.id DESC LIMIT 1) draft_id,
        (SELECT d.status FROM messages d WHERE d.reply_id = r.id ORDER BY d.id DESC LIMIT 1) draft_status
      FROM replies r LEFT JOIN companies c ON c.id = r.company_id LEFT JOIN messages m ON m.id = r.message_id
      WHERE ${w.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`, ...p, Math.min(int(query.limit, 50), 200), int(query.offset, 0))
      .map((r) => ({ ...r, latest_text: latestReplyText(r.body_text) })),
    counts: Object.fromEntries(all('SELECT classification, COUNT(*) n FROM replies GROUP BY classification').map((r) => [r.classification || 'pending', r.n])),
  };
});

api.add('POST', '/api/replies/:id/classify', async ({ params, body, user }) => {
  const r = one('SELECT * FROM replies WHERE id = ?', params.id);
  need(r, 'Reply not found', 404);
  if (body.classification) {
    // Manual override by the admin.
    need(REPLY_CATEGORIES.includes(body.classification), 'Invalid category');
    const c = { classification: body.classification, confidence: 1, classifier: `manual:${user.email}`, reasoning: 'Set by admin', needs_admin: false };
    run('UPDATE replies SET classification = ?, confidence = 1, classifier = ?, reasoning = ?, needs_admin = 0 WHERE id = ?', c.classification, c.classifier, c.reasoning, r.id);
    await applyClassification(r.id, c, user.email);
    return c;
  }
  return processReply(r.id, { actor: user.email });
}, admin);

api.add('POST', '/api/replies/:id/draft', async ({ params, user }) => {
  const r = one('SELECT * FROM replies WHERE id = ?', params.id);
  need(r, 'Reply not found', 404);
  const id = await draftConversionReply(r.id, { classification: r.classification || 'interested', questions: [] }, user.email);
  need(id, 'A reply draft already exists for this message', 409);
  return { id };
}, admin);

api.add('POST', '/api/replies/:id/handled', async ({ params, user }) => {
  run('UPDATE replies SET handled = 1 WHERE id = ?', params.id);
  audit(user.email, 'reply.handled', 'reply', Number(params.id));
  return { ok: true };
}, admin);

api.add('POST', '/api/meetings', async ({ body, user }) => {
  need(body.email, 'Email is required');
  const id = recordMeeting({ email: body.email, scheduledFor: body.scheduled_for || null, source: 'manual', notes: body.notes || null }, user.email);
  return { id };
}, admin);
api.add('GET', '/api/meetings', async () => ({ meetings: all('SELECT m.*, c.name company_name FROM meetings m LEFT JOIN companies c ON c.id = m.company_id ORDER BY m.id DESC LIMIT 200') }));

// ---------------- sending accounts ----------------
const accountView = (a) => {
  const { smtp_pass_enc, imap_pass_enc, ...rest } = a; // never return credentials
  return { ...rest, has_smtp_password: !!smtp_pass_enc, has_imap_password: !!imap_pass_enc, usage: accountUsage(a.id) };
};

api.add('GET', '/api/accounts', async () => ({ accounts: all('SELECT * FROM sending_accounts ORDER BY id').map(accountView) }));

function accountFields(body, existing = null) {
  const f = {
    name: body.name ?? existing?.name, from_name: body.from_name ?? existing?.from_name, from_email: String(body.from_email ?? existing?.from_email ?? '').toLowerCase().trim(),
    smtp_host: body.smtp_host ?? existing?.smtp_host, smtp_port: int(body.smtp_port ?? existing?.smtp_port, 587),
    smtp_secure: body.smtp_secure !== undefined ? (body.smtp_secure === true || body.smtp_secure === 'true' ? 1 : 0) : existing?.smtp_secure ?? 0,
    smtp_user: body.smtp_user ?? existing?.smtp_user,
    smtp_pass_enc: body.smtp_pass ? encrypt(body.smtp_pass) : existing?.smtp_pass_enc,
    imap_host: body.imap_host ?? existing?.imap_host ?? null, imap_port: int(body.imap_port ?? existing?.imap_port, 993),
    imap_secure: body.imap_secure !== undefined ? (body.imap_secure === false || body.imap_secure === 'false' ? 0 : 1) : existing?.imap_secure ?? 1,
    imap_user: body.imap_user ?? existing?.imap_user ?? null,
    imap_pass_enc: body.imap_pass ? encrypt(body.imap_pass) : existing?.imap_pass_enc ?? null,
    daily_limit: Math.min(int(body.daily_limit ?? existing?.daily_limit, 40), 2000), hourly_limit: Math.min(int(body.hourly_limit ?? existing?.hourly_limit, 10), 500),
    enabled: body.enabled !== undefined ? (body.enabled === false || body.enabled === 'false' ? 0 : 1) : existing?.enabled ?? 1,
  };
  need(f.name && f.from_name && /^[^@\s]+@[^@\s]+$/.test(f.from_email) && f.smtp_host && f.smtp_user && f.smtp_pass_enc, 'Name, from name, from email, SMTP host, user and password are required');
  return f;
}

api.add('POST', '/api/accounts', async ({ body, user }) => {
  const f = accountFields(body);
  need(!one('SELECT 1 FROM sending_accounts WHERE from_email = ?', f.from_email), 'An account with this from email already exists', 409);
  const cols = Object.keys(f);
  const r = run(`INSERT INTO sending_accounts (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(f), nowIso(), nowIso());
  audit(user.email, 'account.create', 'sending_account', Number(r.lastInsertRowid), { from_email: f.from_email });
  return { id: Number(r.lastInsertRowid) };
}, admin);

api.add('PUT', '/api/accounts/:id', async ({ params, body, user }) => {
  const a = one('SELECT * FROM sending_accounts WHERE id = ?', params.id);
  need(a, 'Account not found', 404);
  const f = accountFields(body, a);
  run(`UPDATE sending_accounts SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')}, health_status = 'unknown', updated_at = ? WHERE id = ?`, ...Object.values(f), nowIso(), a.id);
  audit(user.email, 'account.update', 'sending_account', a.id);
  return { ok: true };
}, admin);

api.add('DELETE', '/api/accounts/:id', async ({ params, user }) => {
  // Keep history: messages reference the account, so disable instead of delete when used.
  if (one('SELECT 1 FROM messages WHERE sending_account_id = ?', params.id)) run('UPDATE sending_accounts SET enabled = 0, updated_at = ? WHERE id = ?', nowIso(), params.id);
  else run('DELETE FROM sending_accounts WHERE id = ?', params.id);
  audit(user.email, 'account.delete', 'sending_account', Number(params.id));
  return { ok: true };
}, admin);

api.add('POST', '/api/accounts/:id/test', async ({ params, user }) => {
  const a = one('SELECT * FROM sending_accounts WHERE id = ?', params.id);
  need(a, 'Account not found', 404);
  try {
    await verifyAccount(a);
    run(`UPDATE sending_accounts SET health_status = 'ok', last_error = NULL, last_checked_at = ? WHERE id = ?`, nowIso(), a.id);
    audit(user.email, 'account.test', 'sending_account', a.id, { ok: true });
    return { ok: true };
  } catch (e) {
    run(`UPDATE sending_accounts SET health_status = 'failing', last_error = ?, last_checked_at = ? WHERE id = ?`, String(e.message).slice(0, 300), nowIso(), a.id);
    audit(user.email, 'account.test', 'sending_account', a.id, { ok: false });
    return { ok: false, error: e.message };
  }
}, admin);

// ---------------- settings ----------------
api.add('GET', '/api/settings', async () => ({ settings: getSettings(), integrations: integrationStatus(), compliance: complianceProblems() }));
api.add('PUT', '/api/settings', async ({ body, user }) => {
  const changed = updateSettings(body || {});
  audit(user.email, 'settings.update', null, null, changed);
  return { settings: getSettings(), compliance: complianceProblems() };
}, admin);

// ---------------- real-time events (SSE) ----------------
api.add('GET', '/api/events', async ({ req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('event', onEvent);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
  return undefined;
});

// ---------------- public: unsubscribe & webhooks ----------------
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1f2937}button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}</style></head><body>${body}</body></html>`;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

api.add('GET', '/u/:token', async ({ params, res }) => {
  const email = readUnsubscribeToken(params.token);
  res.writeHead(email ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
  res.end(email
    ? page('Unsubscribe', `<h2>Unsubscribe</h2><p>Stop all emails to <b>${escHtml(email)}</b>?</p><form method="post"><button type="submit">Unsubscribe</button></form>`)
    : page('Invalid link', '<h2>This unsubscribe link is invalid.</h2><p>Reply "unsubscribe" to any of our emails and we will remove you.</p>'));
  return undefined;
}, pub);

// Handles both the confirm form and RFC 8058 one-click (List-Unsubscribe-Post).
api.add('POST', '/u/:token', async ({ params, res }) => {
  const email = readUnsubscribeToken(params.token);
  if (!email) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }); res.end(page('Invalid link', '<h2>This unsubscribe link is invalid.</h2>')); return undefined; }
  suppress(email, 'unsubscribe', 'link');
  const contact = one('SELECT * FROM contacts WHERE email_normalized = ? ORDER BY id LIMIT 1', email);
  run(`INSERT INTO email_events (contact_id, type, detail, created_at) VALUES (?, 'unsubscribed', 'link', ?)`, contact?.id ?? null, nowIso());
  if (contact) run(`UPDATE companies SET stage = 'do_not_contact', updated_at = ? WHERE id = ? AND stage != 'client'`, nowIso(), contact.company_id);
  audit('public', 'unsubscribe', 'contact', contact?.id ?? null, { via: 'link' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page('Unsubscribed', `<h2>You're unsubscribed</h2><p>${escHtml(email)} will not receive any more emails from us.</p>`));
  return undefined;
}, { ...pub, rawBody: true });

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Inbound mail webhook (Mailgun/SendGrid/Postmark routes or a custom forwarder).
// Body: { raw } with the full RFC 822 message, or { from, subject, text, message_id, in_reply_to, references }.
api.add('POST', '/hooks/inbound', async ({ req, body, query }) => {
  need(config.inboundWebhookSecret, 'Inbound webhook is not configured', 404);
  need(safeEqual(req.headers['x-webhook-secret'] || query.secret, config.inboundWebhookSecret), 'Forbidden', 403);
  if (body.raw) return handleRawMessage(String(body.raw));
  need(body.from, 'from is required');
  const id = ingestInbound({
    fromEmail: String(body.from).match(/[^\s<>]+@[^\s<>]+/)?.[0] || body.from, subject: body.subject || '', text: body.text || '',
    messageId: body.message_id || null, inReplyTo: body.in_reply_to || null, references: list(body.references).flatMap((r) => r.split(/\s+/)),
    autoSubmitted: !!body.auto_submitted,
  });
  return { type: id ? 'reply' : 'ignored', replyId: id };
}, pub);

// Calendly "invitee.created" webhook -> meeting booked.
api.add('POST', '/hooks/calendly', async ({ req, rawBody, body }) => {
  need(config.calendlyWebhookSigningKey, 'Calendly webhook is not configured', 404);
  const sig = Object.fromEntries(String(req.headers['calendly-webhook-signature'] || '').split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', config.calendlyWebhookSigningKey).update(`${sig.t}.${rawBody}`).digest('hex');
  need(sig.t && safeEqual(sig.v1, expected), 'Invalid signature', 403);
  need(Math.abs(Date.now() / 1000 - Number(sig.t)) < 600, 'Stale signature', 403);
  if (body.event !== 'invitee.created') return { ignored: body.event };
  const p = body.payload || {};
  const id = recordMeeting({ email: p.email, scheduledFor: p.scheduled_event?.start_time || null, source: 'calendly', externalId: p.uri || null, notes: p.name || null }, 'calendly');
  return { id };
}, pub);
