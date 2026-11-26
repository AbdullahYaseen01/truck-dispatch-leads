// Qualified carriers: MC authority continuously ACTIVE for at least `minMonths` (a suspension or revocation restarts
// the clock), at least one tractor (large commercial truck, owned or leased), an active USDOT, a ZIP, and at most
// `maxFleet` power units. Free FMCSA data only, fetched in parallel:
//   1. "Motus AuthHist - All With History" (yu5v-wbh6): every authority status change -> active-since per carrier.
//   2. Company Census (az4n-8mr2): ZIP, trucks, contact details, in batches of 100 USDOT numbers.
import { fetchJson } from '../lib/runtime.js';
import { CENSUS_URL, socrataHeaders, authorityActiveSince, mapPool, normDot, mcFromDocket } from './sources.js';

const HISTORY_URL = 'https://data.transportation.gov/resource/yu5v-wbh6.json';
const PAGE = 50000;
const MONTH_MS = 30.44 * 86400000;
const get = (url, params) => fetchJson(`${url}?${new URLSearchParams(params)}`, { headers: socrataHeaders() }, { retries: 5, timeoutMs: 120000 });
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const num = (v) => Number(v || 0) || 0;

// Census columns for the public MC + ZIP list (no contact details).
export const BASIC_FIELDS = ['dot_number', 'legal_name', 'dba_name', 'phy_city', 'phy_state', 'phy_zip', 'status_code', 'power_units', 'owntract', 'trmtract', 'trptract'];

// Returns { carriers: [{ dot, mc, active_since: 'YYYY-MM-DD', tractors, power_units, zip, census }], stats }.
// `fields` = census columns to fetch (null = all columns, which mapCensusRow needs for a full lead).
export async function findQualifiedCarriers({ minMonths = 5, maxMonths = 0, maxFleet = 10, parallel = 8, fields = BASIC_FIELDS, onlyDots = null } = {}) {
  const now = Date.now();
  const cutoff = ymd(new Date(now - minMonths * MONTH_MS));
  const floor = maxMonths ? ymd(new Date(now - maxMonths * MONTH_MS)) : '';

  const where = `op_auth_type like 'Motor Carrier of Property%'`;
  const total = Number((await get(HISTORY_URL, { $select: 'count(*) as n', $where: where }))[0].n);
  const offsets = Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => i * PAGE);
  const pages = await mapPool(offsets, parallel, (offset) => get(HISTORY_URL, {
    $select: 'usdot_number,docket_number,status_change_date,op_auth_status', $where: where, $order: ':id', $limit: String(PAGE), $offset: String(offset),
  }));
  const byDot = new Map();
  for (const e of pages.flat()) {
    const dot = normDot(e.usdot_number);
    if (!dot || (onlyDots && !onlyDots.has(dot))) continue;
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

  const dots = [...candidates.keys()];
  const batches = [];
  for (let i = 0; i < dots.length; i += 100) batches.push(dots.slice(i, i + 100));
  const failed = [];
  const census = await mapPool(batches, parallel, (batch) => get(CENSUS_URL, {
    ...(fields ? { $select: fields.join(',') } : {}),
    $where: `dot_number in (${batch.map((d) => `'${d}'`).join(',')})`, $limit: '1000',
  }).catch((e) => { failed.push(e.message); return []; }));

  const carriers = [];
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
    const s = c.since;
    carriers.push({ dot, mc: c.mc, active_since: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, tractors, power_units: units, zip, census: r });
  }
  return { carriers, stats: { events: total, carriers_with_history: byDot.size, active_long_enough: candidates.size, skipped, failed: failed.length, batches: batches.length, first_error: failed[0] } };
}
