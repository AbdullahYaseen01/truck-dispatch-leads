// PRIVATE contact list for qualified carriers: MC, ZIP, phone, email and owner name, as each carrier published them
// in its FMCSA registration. Written under data/ (git-ignored, never pushed or deployed).
// Optionally loads carriers into the local dashboard database, where the agents verify the emails, score the leads
// and write personalized emails that wait for your approval. Nothing is sent by this script.
//
// Usage: node src/qualified-contacts.js [--min-months 5] [--max-months 0] [--max-fleet 10] [--states TX,FL]
//          [--import 500] [--out data/private/qualified-contacts.csv]
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { findQualifiedCarriers } from './agents/qualified.js';
import { mapCensusRow } from './agents/sources.js';
import { writeCsv, arg } from './lib/csv.js';

const out = arg('out', path.join(config.dataDir, 'private', 'qualified-contacts.csv'));
const states = new Set(String(arg('states', '')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));
const importN = Number(arg('import', 0));
const started = Date.now();

const { carriers, stats } = await findQualifiedCarriers({
  minMonths: Number(arg('min-months', 5)), maxMonths: Number(arg('max-months', 0)), maxFleet: Number(arg('max-fleet', 10)),
  parallel: Number(arg('parallel', 8)), fields: null, // all census columns: contact details, owner, cargo types
});
const picked = carriers.filter((c) => !states.size || states.has(c.census.phy_state))
  .sort((a, b) => b.active_since.localeCompare(a.active_since)); // shortest active streak first: closest to the 5-month mark

const leads = picked.map((c) => {
  const lead = mapCensusRow(c.census);
  Object.assign(lead, {
    mc_number: c.mc, zip_code: c.zip, operating_status: 'authorized', fleet_size: c.power_units || lead.fleet_size,
    authority_event: { type: 'active', at: `${c.active_since}T00:00:00.000Z`, status: 'Active', reason: 'continuously active since' },
  });
  return { c, lead };
});

fs.mkdirSync(path.dirname(out), { recursive: true });
writeCsv(out, ['mc_number', 'zip_code', 'name', 'owner_name', 'phone', 'email', 'state', 'city', 'usdot_number', 'active_since', 'tractors', 'power_units'],
  leads.map(({ c, lead }) => ({
    mc_number: `MC${c.mc}`, zip_code: c.zip, name: lead.name, owner_name: lead.owner_name || '', phone: lead.phone || '', email: lead.emails[0]?.email || '',
    state: lead.state, city: lead.city, usdot_number: c.dot, active_since: c.active_since, tractors: c.tractors, power_units: c.power_units || '',
  })));
const withEmail = leads.filter(({ lead }) => lead.emails.length).length;
const withPhone = leads.filter(({ lead }) => lead.phone).length;
console.log(`qualified: ${leads.length}${states.size ? ` in ${[...states].join(',')}` : ''}; with email ${withEmail}; with phone ${withPhone}; `
  + `${stats.failed} failed lookups; ${Math.round((Date.now() - started) / 1000)}s -> ${out}`);

if (importN > 0) {
  // Load into the dashboard database. The running server's workers then verify, research, qualify and personalize.
  const { openDb, run, nowIso } = await import('./db/index.js');
  const { upsertLead } = await import('./agents/leads.js');
  const { enqueue } = await import('./queue/queue.js');
  openDb(path.join(config.dataDir, 'leads.db'));
  const now = nowIso();
  const runId = Number(run(`INSERT INTO search_runs (params, status, created_by, created_at, finished_at) VALUES (?, 'done', 'qualified-import', ?, ?)`,
    JSON.stringify({ sources: ['fmcsa_qualified'], states: [...states], import: importN }), now, now).lastInsertRowid);
  let created = 0;
  let merged = 0;
  for (const { lead } of leads.filter(({ lead: l }) => l.emails.length).slice(0, importN)) {
    const res = upsertLead(lead, { searchRunId: runId, query: 'qualified carriers (MC active 5+ months, tractor)' });
    if (res.created) created++; else merged++;
    enqueue('lead.enrich', { companyId: res.companyId }, { dedupeKey: `enrich:${res.companyId}` });
  }
  run(`UPDATE search_runs SET stats = ?, finished_at = ? WHERE id = ?`, JSON.stringify({ total: 1, completed: 1, found: created + merged, new: created, merged }), nowIso(), runId);
  console.log(`imported into the dashboard: ${created} new, ${merged} merged (run #${runId}); verification and personalization run in the server`);
}
