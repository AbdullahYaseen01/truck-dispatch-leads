// Public MC + ZIP list (free, no keys, no database, NO contact details): qualified carriers from agents/qualified.js.
// Rebuilt each run, so carriers that lose authority drop out; first_seen is kept from the previous file.
// Usage: node src/export-mc-zip.js [--min-months 5] [--max-months 0] [--max-fleet 10] [--parallel 8] [--out exports/mc-zip.csv]
import fs from 'node:fs';
import path from 'node:path';
import { findQualifiedCarriers } from './agents/qualified.js';
import { readCsv, writeCsv, arg } from './lib/csv.js';

const out = arg('out', 'exports/mc-zip.csv');
const started = Date.now();
const { carriers, stats } = await findQualifiedCarriers({
  minMonths: Number(arg('min-months', 5)), maxMonths: Number(arg('max-months', 0)), maxFleet: Number(arg('max-fleet', 10)), parallel: Number(arg('parallel', 8)),
});
if (stats.failed > stats.batches / 10) {
  // Too many census lookups failed: keep the previous file rather than publishing a half-empty list.
  console.error(`aborting: ${stats.failed}/${stats.batches} census requests failed, e.g. ${stats.first_error}`);
  process.exit(1);
}
const previous = new Map(readCsv(out).map((r) => [r.usdot_number, r]));
const today = new Date().toISOString().slice(0, 10);
// No "months active" column: it would change daily and churn the file; the site computes it from active_since.
const rows = carriers.map((c) => ({
  mc_number: `MC${c.mc}`, zip_code: c.zip, name: c.census.dba_name || c.census.legal_name, state: c.census.phy_state, city: c.census.phy_city,
  usdot_number: c.dot, active_since: c.active_since, tractors: c.tractors, power_units: c.power_units || '', first_seen: previous.get(c.dot)?.first_seen || today,
})).sort((a, b) => b.active_since.localeCompare(a.active_since) || a.mc_number.localeCompare(b.mc_number));
fs.mkdirSync(path.dirname(out), { recursive: true });
writeCsv(out, ['mc_number', 'zip_code', 'name', 'state', 'city', 'usdot_number', 'active_since', 'tractors', 'power_units', 'first_seen'], rows);
console.log(`${JSON.stringify(stats)}; qualified: ${rows.length} (${rows.filter((r) => !previous.has(r.usdot_number)).length} new); ${Math.round((Date.now() - started) / 1000)}s -> ${out}`);
