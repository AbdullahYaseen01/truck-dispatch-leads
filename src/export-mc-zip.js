// Standalone MC + ZIP export (no database, no keys): new FMCSA operating-authority grants and applications,
// joined to the FMCSA census for the ZIP code. Merges into an existing CSV so the file becomes a running list.
// Usage: node src/export-mc-zip.js [--days 7] [--max-fleet 10] [--out exports/mc-zip.csv]
import fs from 'node:fs';
import path from 'node:path';
import { searchFmcsaAuthority } from './agents/sources.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const days = Number(arg('days', 7));
const maxFleet = Number(arg('max-fleet', 10));
const out = arg('out', 'exports/mc-zip.csv');

const COLS = ['mc_number', 'zip_code', 'name', 'state', 'city', 'usdot_number', 'authority', 'event_date', 'first_seen'];
const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1).filter(Boolean)) {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(Object.fromEntries(COLS.map((c, i) => [c, cells[i] ?? ''])));
  }
  return rows;
}

const existing = fs.existsSync(out) ? parseCsv(fs.readFileSync(out, 'utf8')) : [];
const byDot = new Map(existing.map((r) => [r.usdot_number, r]));
const leads = await searchFmcsaAuthority({ state: null, newWithinDays: days, maxFleet, limit: 100000 });
const today = new Date().toISOString().slice(0, 10);
let added = 0;
for (const l of leads) {
  if (!l.mc_number || !l.zip_code) continue;
  const prev = byDot.get(l.usdot_number);
  if (!prev) added++;
  byDot.set(l.usdot_number, {
    mc_number: `MC${l.mc_number}`, zip_code: l.zip_code, name: l.legal_name || l.name, state: l.state, city: l.city, usdot_number: l.usdot_number,
    authority: l.authority_event?.type || '', event_date: l.authority_event?.at?.slice(0, 10) || '', first_seen: prev?.first_seen || today,
  });
}
const rows = [...byDot.values()].sort((a, b) => b.event_date.localeCompare(a.event_date) || a.mc_number.localeCompare(b.mc_number));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
console.log(`${leads.length} carriers from FMCSA (last ${days} days, <= ${maxFleet} trucks); ${added} new; ${rows.length} total in ${out}`);
