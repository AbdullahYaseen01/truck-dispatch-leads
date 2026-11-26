import { one, all, run, tx, nowIso, json } from '../db/index.js';
import { normalizeName, hostOf, phoneDigits, hostMatches, NON_COMPANY_HOSTS, FREE_EMAIL_DOMAINS, domainOfEmail } from '../lib/text.js';
import { normalizeEmail } from './verification.js';
import { SOURCE_RELIABILITY } from './sources.js';

// Deduplication Agent + lead storage.
// A business is the same business when it shares a USDOT number, website domain, phone, a published
// email, or normalized name within the same state. New evidence merges into the existing record.

export function companyDomain(lead) {
  const h = hostOf(lead.website);
  if (h && !hostMatches(h, NON_COMPANY_HOSTS)) return h;
  for (const e of lead.emails || []) {
    const d = domainOfEmail(e.email);
    if (d && !FREE_EMAIL_DOMAINS.has(d)) return d;
  }
  return null;
}

export function masterOf(id) {
  let cur = id;
  for (let i = 0; i < 10; i++) {
    const r = one('SELECT duplicate_of FROM companies WHERE id = ?', cur);
    if (!r?.duplicate_of) return cur;
    cur = r.duplicate_of;
  }
  return cur;
}

export function findDuplicateCompany(lead) {
  const hit = (row, by) => (row ? { id: masterOf(row.id), by } : null);
  if (lead.source_url) {
    const r = hit(one('SELECT company_id id FROM lead_sources WHERE source_url = ? LIMIT 1', lead.source_url), 'source_url');
    if (r) return r;
  }
  if (lead.is_post) return null; // community posts are only matched by URL
  if (lead.usdot_number) {
    const r = hit(one('SELECT id FROM companies WHERE usdot_number = ? ORDER BY id LIMIT 1', String(lead.usdot_number)), 'usdot');
    if (r) return r;
  }
  const domain = companyDomain(lead);
  if (domain) {
    const r = hit(one('SELECT id FROM companies WHERE domain = ? ORDER BY id LIMIT 1', domain), 'domain');
    if (r) return r;
  }
  const phone = phoneDigits(lead.phone);
  if (phone) {
    const r = hit(one('SELECT id FROM companies WHERE phone = ? ORDER BY id LIMIT 1', phone), 'phone');
    if (r) return r;
  }
  for (const e of lead.emails || []) {
    const r = hit(one('SELECT company_id id FROM contacts WHERE email_normalized = ? ORDER BY id LIMIT 1', normalizeEmail(e.email)), 'email');
    if (r) return r;
  }
  const nn = normalizeName(lead.name);
  if (nn.length >= 3 && lead.state) {
    const r = hit(one('SELECT id FROM companies WHERE normalized_name = ? AND state = ? ORDER BY id LIMIT 1', nn, lead.state), 'name_state');
    if (r) return r;
  }
  return null;
}

export function addContact(companyId, { email, source, source_url = null, contact_type = 'business', name = null, title = null }) {
  const n = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(n)) return null;
  const now = nowIso();
  const r = run(
    `INSERT INTO contacts (company_id, email, email_normalized, name, title, contact_type, source, source_url, discovered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, email_normalized) DO NOTHING`,
    companyId, String(email).trim(), n, name, title, contact_type, source, source_url, now, now,
  );
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export function addSource(companyId, s, searchRunId = null) {
  run(
    `INSERT INTO lead_sources (company_id, source, source_url, query, title, snippet, published_at, search_run_id, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, source, source_url) DO UPDATE SET
       snippet = COALESCE(excluded.snippet, lead_sources.snippet), title = COALESCE(excluded.title, lead_sources.title)`,
    companyId, s.source, s.source_url ?? null, s.query ?? null, s.title ?? null, s.snippet ?? null,
    s.published_at ?? null, searchRunId, nowIso(),
  );
}

const AUTHORITY_STATUSES = ['authorized', 'pending_authority', 'not_authorized'];

// Which operating status wins when evidence merges: FMCSA authority records are the most specific,
// then the FMCSA census (active/inactive USDOT), then other listings by reliability.
export function mergeStatus(c, lead, rel) {
  const s = lead.operating_status;
  if (!s) return c.operating_status;
  if (lead.source === 'fmcsa_authority') return s;
  if (lead.source === 'fmcsa_census') return AUTHORITY_STATUSES.includes(c.operating_status) && s !== 'inactive_usdot' ? c.operating_status : s;
  if (!c.operating_status) return s;
  if (AUTHORITY_STATUSES.includes(c.operating_status) || ['active_usdot', 'inactive_usdot'].includes(c.operating_status)) return c.operating_status;
  return rel >= c.source_reliability ? s : c.operating_status;
}

// Store or merge a raw lead. Returns { companyId, created, mergedBy, newContacts }.
export function upsertLead(lead, { searchRunId = null, query = null } = {}) {
  return tx(() => {
    const now = nowIso();
    const dup = findDuplicateCompany(lead);
    const domain = companyDomain(lead);
    const phone = phoneDigits(lead.phone) || lead.phone || null;
    const rel = lead.reliability ?? SOURCE_RELIABILITY[lead.source] ?? 0.5;
    const eq = lead.equipment_types || [];
    let id;
    const event = lead.authority_event ? JSON.stringify(lead.authority_event) : null;
    if (dup) {
      id = dup.id;
      const c = one('SELECT * FROM companies WHERE id = ?', id);
      const pick = (field, v) => (c[field] === null || c[field] === '') && v !== undefined && v !== null && v !== '' ? v : c[field];
      const authoritative = ['fmcsa_census', 'fmcsa_authority'].includes(lead.source);
      const fleet = authoritative && lead.fleet_size ? lead.fleet_size : pick('fleet_size', lead.fleet_size);
      const history = json(c.fleet_history, []);
      if (authoritative && lead.fleet_size && c.fleet_size && lead.fleet_size !== c.fleet_size) history.push({ at: now, from: c.fleet_size, to: lead.fleet_size });
      const oldEvent = json(c.authority_event, null);
      const newerEvent = event && (!oldEvent?.at || String(lead.authority_event.at) >= String(oldEvent.at)) ? event : c.authority_event;
      run(
        `UPDATE companies SET website = ?, domain = ?, phone = ?, address = ?, city = ?, state = ?, zip_code = ?, equipment_types = ?,
           prospect_category = ?, fleet_size = ?, usdot_number = ?, mc_number = ?, owner_name = ?, operating_status = ?,
           authority_granted_at = ?, authority_event = ?, operating_region = ?, fleet_history = ?, source_reliability = ?,
           last_info_update_at = ?, updated_at = ? WHERE id = ?`,
        pick('website', lead.website), pick('domain', domain), pick('phone', phone), pick('address', lead.address),
        pick('city', lead.city), pick('state', lead.state), authoritative && lead.zip_code ? lead.zip_code : pick('zip_code', lead.zip_code),
        JSON.stringify([...new Set([...json(c.equipment_types, []), ...eq])]),
        c.prospect_category === 'Community Post' && lead.prospect_category && lead.prospect_category !== 'Community Post' ? lead.prospect_category : pick('prospect_category', lead.prospect_category),
        fleet,
        pick('usdot_number', lead.usdot_number ? String(lead.usdot_number) : null),
        lead.mc_number || c.mc_number,
        pick('owner_name', lead.owner_name),
        mergeStatus(c, lead, rel),
        authoritative && lead.authority_granted_at && lead.source === 'fmcsa_census' ? lead.authority_granted_at : pick('authority_granted_at', lead.authority_granted_at),
        newerEvent, pick('operating_region', lead.operating_region), JSON.stringify(history.slice(-20)),
        Math.max(c.source_reliability, rel), now, now, id,
      );
    } else {
      const r = run(
        `INSERT INTO companies (name, normalized_name, website, domain, phone, address, city, state, zip_code, country, equipment_types,
           prospect_category, fleet_size, usdot_number, mc_number, owner_name, operating_status, authority_granted_at, authority_event,
           operating_region, source_reliability, first_discovered_at, last_info_update_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lead.name, normalizeName(lead.name), lead.website ?? null, domain, phone, lead.address ?? null, lead.city ?? null,
        lead.state ?? null, lead.zip_code ?? null, lead.country || 'US', JSON.stringify(eq), lead.prospect_category ?? null, lead.fleet_size ?? null,
        lead.usdot_number ? String(lead.usdot_number) : null, lead.mc_number ?? null, lead.owner_name ?? null, lead.operating_status ?? null,
        lead.authority_granted_at ?? null, event, lead.operating_region ?? null, rel, now, now, now, now,
      );
      id = Number(r.lastInsertRowid);
    }
    addSource(id, { ...lead, query }, searchRunId);
    const newContacts = [];
    for (const e of lead.emails || []) {
      const cid = addContact(id, { email: e.email, source: lead.source, source_url: e.source_url || lead.source_url, contact_type: e.contact_type, name: e.contact_type === 'owner' ? lead.owner_name : null });
      if (cid) newContacts.push(cid);
    }
    return { companyId: id, created: !dup, mergedBy: dup?.by || null, newContacts };
  });
}

function mergeInto(dupId, masterId) {
  tx(() => {
    run('UPDATE OR IGNORE lead_sources SET company_id = ? WHERE company_id = ?', masterId, dupId);
    run('UPDATE OR IGNORE contacts SET company_id = ? WHERE company_id = ?', masterId, dupId);
    // Contacts left behind already exist on the master: mark them duplicates of the master's copy.
    for (const c of all('SELECT id, email_normalized FROM contacts WHERE company_id = ?', dupId)) {
      const m = one('SELECT id FROM contacts WHERE company_id = ? AND email_normalized = ?', masterId, c.email_normalized);
      run(`UPDATE contacts SET duplicate_of = ?, verification_status = 'duplicate' WHERE id = ?`, m?.id ?? null, c.id);
    }
    run('UPDATE companies SET duplicate_of = ?, updated_at = ? WHERE id = ?', masterId, nowIso(), dupId);
  });
}

// Periodic sweep for duplicates that slipped in before a shared key was known (e.g. DOT found later on a website).
export function dedupeSweep() {
  let merged = 0;
  for (const key of ['usdot_number', 'domain', 'phone']) {
    const groups = all(
      `SELECT MIN(id) master, GROUP_CONCAT(id) ids FROM companies
       WHERE duplicate_of IS NULL AND ${key} IS NOT NULL AND ${key} != '' GROUP BY ${key} HAVING COUNT(*) > 1`,
    );
    for (const g of groups) {
      for (const id of String(g.ids).split(',').map(Number)) {
        if (id !== g.master) { mergeInto(id, g.master); merged++; }
      }
    }
  }
  return merged;
}
