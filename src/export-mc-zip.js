// High-quality lead export (free, no keys, no database): carriers whose MC authority has been ACTIVE for at least
// `--min-months` months (no suspension since) and who run at least one large commercial truck (a tractor, owned or
// leased). Output: MC number + ZIP code (+ context) in a CSV. Rebuilt each run, so carriers that lose authority drop out;
// first_seen is kept from the previous file.
//
// Sources, all fetched in parallel:
//   1. FMCSA "Motus AuthHist - All With History" (yu5v-wbh6): every authority status change -> active-since date per carrier.
//   2. FMCSA Company Census (az4n-8mr2): ZIP, tractors, power units, name, in batches of 100 USDOT numbers.
//
// Usage: node src/export-mc-zip.js [--min-months 5] [--max-months 0] [--max-fleet 10] [--parallel 8] [--out exports/mc-zip.csv]
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from './lib/runtime.js';
import { CENSUS_URL, socrataHeaders, authorityActiveSince, mapPool, normDot, mcFromDocket } from './agents/sources.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const minMonths = Number(arg('min-months', 5));
const maxMonths = Number(arg('max-months', 0)); // 0 = no upper limit
const maxFleet = Number(arg('max-fleet', 10));
const parallel = Number(arg('parallel', 8));
const out = arg('out', 'exports/mc-zip.csv');

const HISTORY_URL = 'https://data.transportation.gov/resource/yu5v-wbh6.json';
const PAGE = 50000;
// No "months active" column: it would change daily and churn the file; the site computes it from active_since.
const COLS = ['mc_number', 'zip_code', 'name', 'state', 'city', 'usdot_number', 'active_since', 'tractors', 'power_units', 'first_seen'];
const get = (url, params) => fetchJson(`${url}?${new URLSearchParams(params)}`, { headers: socrataHeaders() }, { retries: 5, timeoutMs: 120000 });
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = (s) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');
const num = (v) => Number(v || 0) || 0;
const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = (lines.shift() || '').split(',');
  return lines.map((line) => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}

const started = Date.now();
const now = new Date();
const cutoff = ymd(new Date(now.getTime() - minMonths * 30.44 * 86400000));
const floor = maxMonths ? ymd(new Date(now.getTime() - maxMonths * 30.44 * 86400000)) : '';

// 1. Full property-carrier authority history, all pages in parallel.
const where = `op_auth_type like 'Motor Carrier of Property%'`;
const total = Number((await get(HISTORY_URL, { $select: 'count(*) as n', $where: where }))[0].n);
const offsets = Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => i * PAGE);
const pages = await mapPool(offsets, parallel, (offset) => get(HISTORY_URL, {
  $select: 'usdot_number,docket_number,status_change_date,op_auth_status', $where: where, $order: ':id', $limit: String(PAGE), $offset: String(offset),
}));
const byDot = new Map();
for (const e of pages.flat()) {
  const dot = normDot(e.usdot_number);
  if (!dot) continue;
  if (!byDot.has(dot)) byDot.set(dot, []);
  byDot.get(dot).push(e);
}
const candidates = new Map();
for (const [dot, events] of byDot) {
  const since = authorityActiveSince(events);
  if (!since || since > cutoff || (floor && since < floor)) continue;
  const mc = events.map((e) => mcFromDocket(e.docket_number)).find(Boolean);
  if (mc) candidates.set(dot, { since, mc });
}

// 2. Census join (100 USDOT numbers per request, `parallel` requests at a time): ZIP and truck types.
const dots = [...candidates.keys()];
const batches = [];
for (let i = 0; i < dots.length; i += 100) batches.push(dots.slice(i, i + 100));
const failed = [];
const census = await mapPool(batches, parallel, (batch) => get(CENSUS_URL, {
  $select: 'dot_number,legal_name,dba_name,phy_city,phy_state,phy_zip,status_code,power_units,owntract,trmtract,trptract',
  $where: `dot_number in (${batch.map((d) => `'${d}'`).join(',')})`, $limit: '1000',
}).catch((e) => { failed.push(e.message); return []; }));

const previous = fs.existsSync(out) ? new Map(parseCsv(fs.readFileSync(out, 'utf8')).map((r) => [r.usdot_number, r])) : new Map();
const today = now.toISOString().slice(0, 10);
const rows = [];
const skipped = { inactive_usdot: 0, no_zip: 0, no_tractor: 0, fleet_too_large: 0 };
for (const r of census.flat()) {
  const dot = normDot(r.dot_number);
  const c = candidates.get(dot);
  if (!c) continue;
  const tractors = num(r.owntract) + num(r.trmtract) + num(r.trptract);
  const units = num(r.power_units);
  const zip = /^\d{5}/.test(r.phy_zip || '') ? r.phy_zip.slice(0, 5) : '';
  if (r.status_code !== 'A') { skipped.inactive_usdot++; continue; }
  if (!zip) { skipped.no_zip++; continue; }
  if (tractors < 1) { skipped.no_tractor++; continue; }
  if (units > maxFleet) { skipped.fleet_too_large++; continue; }
  rows.push({
    mc_number: `MC${c.mc}`, zip_code: zip, name: r.dba_name || r.legal_name, state: r.phy_state, city: r.phy_city, usdot_number: dot,
    active_since: iso(c.since), tractors, power_units: units || '', first_seen: previous.get(dot)?.first_seen || today,
  });
}
if (failed.length > batches.length / 10) {
  // Too many census lookups failed: keep the previous file rather than publishing a half-empty list.
  console.error(`aborting: ${failed.length}/${batches.length} census requests failed, e.g. ${failed[0]}`);
  process.exit(1);
}
rows.sort((a, b) => b.active_since.localeCompare(a.active_since) || a.mc_number.localeCompare(b.mc_number));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
const added = rows.filter((r) => !previous.has(r.usdot_number)).length;
console.log(`authority history: ${total} events, ${byDot.size} carriers; active >= ${minMonths} months${maxMonths ? ` and <= ${maxMonths}` : ''}: ${candidates.size}; `
  + `with ZIP + tractor + <= ${maxFleet} power units: ${rows.length} (${added} new); skipped ${JSON.stringify(skipped)}; `
  + `${failed.length} failed lookups; ${Math.round((Date.now() - started) / 1000)}s -> ${out}`);
